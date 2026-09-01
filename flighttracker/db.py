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
        """SELECT price, currency, airline, stops, captured_at FROM fares
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
