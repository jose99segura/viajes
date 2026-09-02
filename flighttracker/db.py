from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS fares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,          -- UTC ISO timestamp of the scrape
    source TEXT NOT NULL,               -- 'ryanair' | 'google'
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    departure TEXT NOT NULL,            -- local departure datetime ISO
    arrival TEXT,                       -- local arrival datetime ISO (nullable)
    airline TEXT,
    stops INTEGER NOT NULL DEFAULT 0,
    price REAL NOT NULL,
    currency TEXT NOT NULL,
    sold_out INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fares_route_dep
    ON fares (origin, destination, departure);
CREATE INDEX IF NOT EXISTS idx_fares_captured
    ON fares (captured_at);

-- Round trips quoted as a single price for a departure date + trip length,
-- with no departure times (Luxair). Kept apart from `fares`, which is
-- per-leg with exact times.
CREATE TABLE IF NOT EXISTS package_fares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    source TEXT NOT NULL,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    out_date TEXT NOT NULL,
    nights INTEGER NOT NULL,
    price REAL NOT NULL,
    currency TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pkg_route_date
    ON package_fares (origin, destination, out_date);

-- Alert rules: "tell me when a trip like this exists". Each is a saved
-- TripFilter plus a name; NULL means "no limit" for that field.
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    name TEXT NOT NULL,
    airport TEXT,
    max_price REAL,
    max_days_off INTEGER,
    min_nights INTEGER NOT NULL DEFAULT 1,
    max_nights INTEGER NOT NULL DEFAULT 14,
    direct_only INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1
);

-- Which trips have matched which alert, so a fetch can say what is NEW and
-- the UI can show an unread count. Cleared for trips that stop matching.
CREATE TABLE IF NOT EXISTS alert_hits (
    alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    trip_key TEXT NOT NULL,
    price REAL NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (alert_id, trip_key)
);

-- Saved trips/flights. `kind` is 'trip' (round trip) or 'flight' (one way).
-- The return columns are NULL for a one-way favourite.
CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    out_origin TEXT NOT NULL,
    out_destination TEXT NOT NULL,
    out_departure TEXT NOT NULL,
    ret_origin TEXT,
    ret_destination TEXT,
    ret_departure TEXT,
    note TEXT,
    price_at_save REAL,
    UNIQUE (kind, out_origin, out_destination, out_departure,
            ret_origin, ret_destination, ret_departure)
);
"""


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(fares)")}
    if "stops" not in cols:
        conn.execute("ALTER TABLE fares ADD COLUMN stops INTEGER NOT NULL DEFAULT 0")
        # Older Google rows encoded stop count in the airline string.
        conn.execute(
            "UPDATE fares SET stops = 1 WHERE airline LIKE '%(1 stop)'"
        )
        conn.execute(
            "UPDATE fares SET stops = 2 WHERE airline LIKE '%(2 stops)'"
        )
        conn.execute(
            "UPDATE fares SET stops = 3 WHERE airline LIKE '%(3 stops)'"
        )
        conn.execute(
            """UPDATE fares
               SET airline = TRIM(SUBSTR(airline, 1, INSTR(airline, ' (') - 1))
               WHERE airline LIKE '% (_ stop%)'"""
        )
        conn.commit()


def run_timestamp() -> str:
    """One timestamp per fetch run, so a run is a single snapshot in the
    history — not one snapshot per insert batch."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def insert_fares(
    conn: sqlite3.Connection, fares: list[dict], captured_at: str | None = None
) -> int:
    captured_at = captured_at or run_timestamp()
    rows = [
        (
            captured_at,
            f["source"],
            f["origin"],
            f["destination"],
            f["departure"],
            f.get("arrival"),
            f.get("airline"),
            int(f.get("stops", 0)),
            f["price"],
            f["currency"],
            int(f.get("sold_out", False)),
        )
        for f in fares
    ]
    conn.executemany(
        """INSERT INTO fares
           (captured_at, source, origin, destination, departure, arrival,
            airline, stops, price, currency, sold_out)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    conn.commit()
    return len(rows)


def latest_snapshot(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Most recent price seen for each (route, departure)."""
    return conn.execute(
        """
        SELECT f.* FROM fares f
        JOIN (
            SELECT origin, destination, departure, MAX(captured_at) AS mc
            FROM fares GROUP BY origin, destination, departure
        ) last ON f.origin = last.origin
              AND f.destination = last.destination
              AND f.departure = last.departure
              AND f.captured_at = last.mc
        WHERE f.sold_out = 0 AND f.departure >= date('now')
        ORDER BY f.departure
        """
    ).fetchall()


def insert_packages(
    conn: sqlite3.Connection, fares: list[dict], captured_at: str | None = None
) -> int:
    captured_at = captured_at or run_timestamp()
    conn.executemany(
        """INSERT INTO package_fares
           (captured_at, source, origin, destination, out_date, nights,
            price, currency)
           VALUES (?,?,?,?,?,?,?,?)""",
        [
            (captured_at, f["source"], f["origin"], f["destination"],
             f["out_date"], f["nights"], f["price"], f["currency"])
            for f in fares
        ],
    )
    conn.commit()
    return len(fares)


def latest_packages(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Most recent price for each (route, departure date, trip length)."""
    return conn.execute(
        """
        SELECT p.* FROM package_fares p
        JOIN (
            SELECT origin, destination, out_date, nights, MAX(captured_at) mc
            FROM package_fares GROUP BY origin, destination, out_date, nights
        ) last ON p.origin = last.origin AND p.destination = last.destination
              AND p.out_date = last.out_date AND p.nights = last.nights
              AND p.captured_at = last.mc
        WHERE p.out_date >= date('now')
        ORDER BY p.out_date
        """
    ).fetchall()


def favorite_key(fav: dict) -> str:
    """Stable identity for a favourite, shared by the UI and the DB."""
    return "|".join([
        fav["kind"], fav["out_origin"], fav["out_destination"], fav["out_departure"],
        fav.get("ret_origin") or "", fav.get("ret_destination") or "",
        fav.get("ret_departure") or "",
    ])


def list_favorites(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM favorites ORDER BY out_departure"
    ).fetchall()


def add_favorite(conn: sqlite3.Connection, fav: dict) -> None:
    conn.execute(
        """INSERT OR IGNORE INTO favorites
           (created_at, kind, out_origin, out_destination, out_departure,
            ret_origin, ret_destination, ret_departure, note, price_at_save)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            run_timestamp(), fav["kind"], fav["out_origin"], fav["out_destination"],
            fav["out_departure"], fav.get("ret_origin"), fav.get("ret_destination"),
            fav.get("ret_departure"), fav.get("note"), fav.get("price_at_save"),
        ),
    )
    conn.commit()


def remove_favorite(conn: sqlite3.Connection, fav: dict) -> None:
    conn.execute(
        """DELETE FROM favorites WHERE kind = ? AND out_origin = ?
           AND out_destination = ? AND out_departure = ?
           AND IFNULL(ret_origin,'') = ? AND IFNULL(ret_destination,'') = ?
           AND IFNULL(ret_departure,'') = ?""",
        (
            fav["kind"], fav["out_origin"], fav["out_destination"], fav["out_departure"],
            fav.get("ret_origin") or "", fav.get("ret_destination") or "",
            fav.get("ret_departure") or "",
        ),
    )
    conn.commit()


def current_price(
    conn: sqlite3.Connection, origin: str, destination: str, departure: str
) -> sqlite3.Row | None:
    """Cheapest fare for one flight in the most recent capture. Both providers
    can list the same departure, so take the best of them, not an arbitrary
    row — otherwise a saved trip appears to jump in price."""
    return conn.execute(
        """SELECT price, currency, airline, stops, source, captured_at FROM fares
           WHERE origin = ? AND destination = ? AND departure = ?
             AND captured_at = (
               SELECT MAX(captured_at) FROM fares
               WHERE origin = ? AND destination = ? AND departure = ?)
           ORDER BY price ASC LIMIT 1""",
        (origin, destination, departure, origin, destination, departure),
    ).fetchone()


def current_package(
    conn: sqlite3.Connection, origin: str, destination: str,
    out_date: str, nights: int
) -> sqlite3.Row | None:
    return conn.execute(
        """SELECT price, currency, source FROM package_fares
           WHERE origin = ? AND destination = ? AND out_date = ? AND nights = ?
           ORDER BY captured_at DESC LIMIT 1""",
        (origin, destination, out_date, nights),
    ).fetchone()


def package_extremes(
    conn: sqlite3.Connection, origin: str, destination: str,
    out_date: str, nights: int
) -> sqlite3.Row | None:
    return conn.execute(
        """SELECT MIN(price) lo, MAX(price) hi FROM package_fares
           WHERE origin = ? AND destination = ? AND out_date = ? AND nights = ?""",
        (origin, destination, out_date, nights),
    ).fetchone()


def price_extremes(
    conn: sqlite3.Connection, origin: str, destination: str, departure: str
) -> sqlite3.Row | None:
    """Min/max/first price ever seen for one flight, to show the trend."""
    return conn.execute(
        """SELECT MIN(price) lo, MAX(price) hi, COUNT(*) n FROM fares
           WHERE origin = ? AND destination = ? AND departure = ?""",
        (origin, destination, departure),
    ).fetchone()


def daily_minima(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Cheapest current fare per (route, calendar day) — powers the calendar."""
    return conn.execute(
        """
        SELECT f.origin, f.destination, DATE(f.departure) day,
               MIN(f.price) price
        FROM fares f
        JOIN (
            SELECT origin, destination, departure, MAX(captured_at) mc
            FROM fares GROUP BY origin, destination, departure
        ) last ON f.origin = last.origin AND f.destination = last.destination
              AND f.departure = last.departure AND f.captured_at = last.mc
        WHERE f.sold_out = 0 AND f.departure >= date('now')
        GROUP BY f.origin, f.destination, DATE(f.departure)
        ORDER BY day
        """
    ).fetchall()


def price_history(
    conn: sqlite3.Connection, origin: str, destination: str, day: str
) -> list[sqlite3.Row]:
    """All captures for flights on a given YYYY-MM-DD, oldest first."""
    return conn.execute(
        """
        SELECT captured_at, departure, airline, stops, price, currency, source
        FROM fares
        WHERE origin = ? AND destination = ? AND departure LIKE ?
        ORDER BY captured_at
        """,
        (origin.upper(), destination.upper(), f"{day}%"),
    ).fetchall()


# ---------- alerts ----------

ALERT_FIELDS = ("name", "airport", "max_price", "max_days_off",
                "min_nights", "max_nights", "direct_only", "enabled")


def list_alerts(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM alerts ORDER BY id").fetchall()


def get_alert(conn: sqlite3.Connection, alert_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()


def save_alert(conn: sqlite3.Connection, data: dict, alert_id: int | None = None) -> int:
    vals = {
        "name": (data.get("name") or "Alerta").strip(),
        "airport": (data.get("airport") or "").upper() or None,
        "max_price": float(data["max_price"]) if data.get("max_price") not in (None, "") else None,
        "max_days_off": int(data["max_days_off"]) if data.get("max_days_off") not in (None, "") else None,
        "min_nights": int(data.get("min_nights") or 1),
        "max_nights": int(data.get("max_nights") or 14),
        "direct_only": 1 if data.get("direct_only") else 0,
        "enabled": 0 if data.get("enabled") is False else 1,
    }
    if alert_id is None:
        cur = conn.execute(
            f"INSERT INTO alerts (created_at, {', '.join(vals)}) "
            f"VALUES (?, {', '.join('?' for _ in vals)})",
            (run_timestamp(), *vals.values()),
        )
        alert_id = cur.lastrowid
    else:
        conn.execute(
            f"UPDATE alerts SET {', '.join(f'{k} = ?' for k in vals)} WHERE id = ?",
            (*vals.values(), alert_id),
        )
    conn.commit()
    return alert_id


def delete_alert(conn: sqlite3.Connection, alert_id: int) -> None:
    conn.execute("DELETE FROM alert_hits WHERE alert_id = ?", (alert_id,))
    conn.execute("DELETE FROM alerts WHERE id = ?", (alert_id,))
    conn.commit()


def record_hits(conn: sqlite3.Connection, alert_id: int,
                hits: dict[str, float]) -> tuple[set[str], int]:
    """Upsert the current matches of one alert. Returns (new keys, unseen count).
    Matches that disappeared are dropped so they can count as new if they return."""
    now = run_timestamp()
    existing = {
        r["trip_key"]: r for r in conn.execute(
            "SELECT trip_key, seen FROM alert_hits WHERE alert_id = ?", (alert_id,))
    }
    new_keys = set()
    for key, price in hits.items():
        if key in existing:
            conn.execute(
                "UPDATE alert_hits SET price = ?, last_seen = ? "
                "WHERE alert_id = ? AND trip_key = ?", (price, now, alert_id, key))
        else:
            new_keys.add(key)
            conn.execute(
                "INSERT INTO alert_hits (alert_id, trip_key, price, first_seen, last_seen, seen) "
                "VALUES (?,?,?,?,?,0)", (alert_id, key, price, now, now))
    gone = set(existing) - set(hits)
    if gone:
        conn.executemany(
            "DELETE FROM alert_hits WHERE alert_id = ? AND trip_key = ?",
            [(alert_id, k) for k in gone])
    conn.commit()
    unseen = conn.execute(
        "SELECT COUNT(*) FROM alert_hits WHERE alert_id = ? AND seen = 0", (alert_id,)
    ).fetchone()[0]
    return new_keys, unseen


def unseen_keys(conn: sqlite3.Connection, alert_id: int) -> set[str]:
    return {r["trip_key"] for r in conn.execute(
        "SELECT trip_key FROM alert_hits WHERE alert_id = ? AND seen = 0", (alert_id,))}


def mark_alert_seen(conn: sqlite3.Connection, alert_id: int | None = None) -> None:
    if alert_id is None:
        conn.execute("UPDATE alert_hits SET seen = 1")
    else:
        conn.execute("UPDATE alert_hits SET seen = 1 WHERE alert_id = ?", (alert_id,))
    conn.commit()
