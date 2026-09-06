"""Storage layer, on Postgres.

Ported from sqlite3 without changing the surface: every function keeps its
name, arguments and the shape of what it returns, so scoring.py, trips.py,
alerts.py, web.py and chat.py did not have to change with it.

Three decisions hold that in place.

**The schema lives in Drizzle, not here.** `src/db/schema.ts` owns it and
`pnpm db:migrate` applies it. This module no longer creates tables on
connect, so a fresh database must be migrated before the first fetch.

**Rows come back looking like sqlite3.Row.** Postgres returns `datetime`,
`Decimal` and `bool` where SQLite returned text, float and integer. The
callers do `datetime.fromisoformat(r["departure"])`, arithmetic on
`r["price"]` and `r["captured_at"][:16]`, and `trip_key` joins departures
into a string that must stay byte-identical or every stored alert hit would
re-appear as new. So `Row` converts on the way out: timestamps to ISO text,
numerics to float, dates to `YYYY-MM-DD`.

**Placeholders stay `?`.** pg8000 accepts qmark paramstyle, which also means
a literal `%` in SQL needs no escaping.

pg8000 rather than psycopg: pure Python, no libpq. psycopg-binary has no
Windows ARM64 wheel, and the dev machine is Windows ARM64 -- the fetcher
would have been container-only. Same constraint that keeps `cryptography`
out of chat.py.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timezone
from decimal import Decimal

import pg8000.dbapi

from .config import load_env

# `?` placeholders, as the SQLite version used. Module-level because pg8000
# reads it at execute time.
pg8000.dbapi.paramstyle = "qmark"


class Row(dict):
    """A dict that also indexes by position, as sqlite3.Row did.

    `record_hits` reads a COUNT with `.fetchone()[0]`, and other callers use
    names. Supporting both is what keeps the callers untouched.
    """

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


def _value(value):
    """Postgres type -> the type the SQLite version handed back.

    Timestamps become ISO text: `departure` is a naive wall clock and
    isoformat() renders it as "2026-09-03T17:20:00", exactly what was stored
    before. `captured_at` is aware and renders with "+00:00", also as before.
    """
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


class Result(list):
    """A cursor-shaped list, so `.execute(...).fetchall()`, `.fetchone()` and
    plain iteration all keep working."""

    def fetchall(self) -> list[Row]:
        return list(self)

    def fetchone(self) -> Row | None:
        return self[0] if self else None


class Connection:
    """Thin wrapper giving pg8000 the sqlite3.Connection surface this code
    already uses: execute/executemany/commit/close."""

    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql: str, params=()) -> Result:
        cur = self._raw.cursor()
        cur.execute(sql, params)
        if cur.description is None:
            return Result()
        names = [d[0] for d in cur.description]
        return Result(
            Row(zip(names, (_value(v) for v in row))) for row in cur.fetchall()
        )

    def executemany(self, sql: str, seq) -> None:
        rows = list(seq)
        if not rows:
            return
        self._raw.cursor().executemany(sql, rows)

    def commit(self) -> None:
        self._raw.commit()

    def rollback(self) -> None:
        self._raw.rollback()

    def close(self) -> None:
        self._raw.close()


def connect(url: str | None = None) -> Connection:
    """Open a connection. The schema is Drizzle's; run `pnpm db:migrate`
    against a fresh database before the first fetch."""
    load_env()
    url = url or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Copy .env.example to .env and point it "
            "at the database, or run `docker compose up -d` for a local one."
        )
    from urllib.parse import unquote, urlparse

    parsed = urlparse(url)
    if parsed.scheme not in ("postgres", "postgresql"):
        raise RuntimeError(f"DATABASE_URL is not a Postgres URL: {url!r}")
    return Connection(
        pg8000.dbapi.connect(
            user=unquote(parsed.username or ""),
            password=unquote(parsed.password or ""),
            host=parsed.hostname or "localhost",
            port=parsed.port or 5432,
            database=(parsed.path or "/").lstrip("/"),
        )
    )


def run_timestamp() -> str:
    """One timestamp per fetch run, so a run is a single snapshot in the
    history — not one snapshot per insert batch."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def insert_fares(
    conn: Connection, fares: list[dict], captured_at: str | None = None
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
            bool(f.get("sold_out", False)),
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


def latest_snapshot(conn: Connection) -> list[Row]:
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
        WHERE f.sold_out = false AND f.departure >= CURRENT_DATE
        ORDER BY f.departure
        """
    ).fetchall()


def insert_packages(
    conn: Connection, fares: list[dict], captured_at: str | None = None
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


def latest_packages(conn: Connection) -> list[Row]:
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
        WHERE p.out_date >= CURRENT_DATE
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


def list_favorites(conn: Connection) -> list[Row]:
    return conn.execute(
        "SELECT * FROM favorites ORDER BY out_departure"
    ).fetchall()


def add_favorite(conn: Connection, fav: dict) -> None:
    # ON CONFLICT DO NOTHING replaces INSERT OR IGNORE. The constraint is
    # UNIQUE NULLS NOT DISTINCT, so a one-way favourite (all three ret_*
    # columns NULL) is now genuinely deduplicated — under SQLite the NULLs
    # counted as distinct and it could be saved twice.
    conn.execute(
        """INSERT INTO favorites
           (created_at, kind, out_origin, out_destination, out_departure,
            ret_origin, ret_destination, ret_departure, note, price_at_save)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT DO NOTHING""",
        (
            run_timestamp(), fav["kind"], fav["out_origin"], fav["out_destination"],
            fav["out_departure"], fav.get("ret_origin"), fav.get("ret_destination"),
            fav.get("ret_departure"), fav.get("note"), fav.get("price_at_save"),
        ),
    )
    conn.commit()


def remove_favorite(conn: Connection, fav: dict) -> None:
    # IS NOT DISTINCT FROM treats NULL = NULL as true, which is what the
    # SQLite version's IFNULL(col,'') = '' achieved. It also works on the
    # timestamp column: casting ret_departure to text for a COALESCE would
    # render it with a space where the UI sends a "T", and the one-way
    # comparison would silently never match.
    conn.execute(
        """DELETE FROM favorites WHERE kind = ? AND out_origin = ?
           AND out_destination = ? AND out_departure = ?
           AND ret_origin IS NOT DISTINCT FROM ?
           AND ret_destination IS NOT DISTINCT FROM ?
           AND ret_departure IS NOT DISTINCT FROM CAST(? AS timestamp)""",
        (
            fav["kind"], fav["out_origin"], fav["out_destination"], fav["out_departure"],
            fav.get("ret_origin") or None, fav.get("ret_destination") or None,
            fav.get("ret_departure") or None,
        ),
    )
    conn.commit()


def current_price(
    conn: Connection, origin: str, destination: str, departure: str
) -> Row | None:
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
    conn: Connection, origin: str, destination: str,
    out_date: str, nights: int
) -> Row | None:
    return conn.execute(
        """SELECT price, currency, source FROM package_fares
           WHERE origin = ? AND destination = ? AND out_date = ? AND nights = ?
           ORDER BY captured_at DESC LIMIT 1""",
        (origin, destination, out_date, nights),
    ).fetchone()


def package_extremes(
    conn: Connection, origin: str, destination: str,
    out_date: str, nights: int
) -> Row | None:
    return conn.execute(
        """SELECT MIN(price) lo, MAX(price) hi FROM package_fares
           WHERE origin = ? AND destination = ? AND out_date = ? AND nights = ?""",
        (origin, destination, out_date, nights),
    ).fetchone()


def price_extremes(
    conn: Connection, origin: str, destination: str, departure: str
) -> Row | None:
    """Min/max/first price ever seen for one flight, to show the trend."""
    return conn.execute(
        """SELECT MIN(price) lo, MAX(price) hi, COUNT(*) n FROM fares
           WHERE origin = ? AND destination = ? AND departure = ?""",
        (origin, destination, departure),
    ).fetchone()


def daily_minima(conn: Connection) -> list[Row]:
    """Cheapest current fare per (route, calendar day) — powers the calendar."""
    return conn.execute(
        """
        -- `AS day` is not optional: `day` is a keyword in Postgres (interval
        -- units), and a bare alias after a CAST fails to parse.
        SELECT f.origin, f.destination, CAST(f.departure AS date) AS day,
               MIN(f.price) AS price
        FROM fares f
        JOIN (
            SELECT origin, destination, departure, MAX(captured_at) mc
            FROM fares GROUP BY origin, destination, departure
        ) last ON f.origin = last.origin AND f.destination = last.destination
              AND f.departure = last.departure AND f.captured_at = last.mc
        WHERE f.sold_out = false AND f.departure >= CURRENT_DATE
        GROUP BY f.origin, f.destination, CAST(f.departure AS date)
        ORDER BY day
        """
    ).fetchall()


def price_history(
    conn: Connection, origin: str, destination: str, day: str
) -> list[Row]:
    """All captures for flights on a given YYYY-MM-DD, oldest first."""
    # A half-open range on the timestamp rather than SQLite's `LIKE 'day%'`
    # on the text. It uses idx_fares_route_dep, which the LIKE could not.
    return conn.execute(
        """
        SELECT captured_at, departure, airline, stops, price, currency, source
        FROM fares
        WHERE origin = ? AND destination = ?
          AND departure >= CAST(? AS date)
          AND departure < CAST(? AS date) + INTERVAL '1 day'
        ORDER BY captured_at
        """,
        (origin.upper(), destination.upper(), day, day),
    ).fetchall()


# ---------- alerts ----------

ALERT_FIELDS = ("name", "airport", "max_price", "max_days_off",
                "min_nights", "max_nights", "direct_only", "enabled")


def list_alerts(conn: Connection) -> list[Row]:
    return conn.execute("SELECT * FROM alerts ORDER BY id").fetchall()


def get_alert(conn: Connection, alert_id: int) -> Row | None:
    return conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()


def save_alert(conn: Connection, data: dict, alert_id: int | None = None) -> int:
    vals = {
        "name": (data.get("name") or "Alerta").strip(),
        "airport": (data.get("airport") or "").upper() or None,
        "max_price": float(data["max_price"]) if data.get("max_price") not in (None, "") else None,
        "max_days_off": int(data["max_days_off"]) if data.get("max_days_off") not in (None, "") else None,
        "min_nights": int(data.get("min_nights") or 1),
        "max_nights": int(data.get("max_nights") or 14),
        # Real booleans now, not 0/1. The callers still pass 0/1 (see
        # alerts.DEFAULT_ALERTS) and the UI passes JSON true/false; bool()
        # accepts both.
        "direct_only": bool(data.get("direct_only")),
        "enabled": data.get("enabled") is not False,
    }
    if alert_id is None:
        row = conn.execute(
            f"INSERT INTO alerts (created_at, {', '.join(vals)}) "
            f"VALUES (?, {', '.join('?' for _ in vals)}) RETURNING id",
            (run_timestamp(), *vals.values()),
        ).fetchone()
        alert_id = row["id"]
    else:
        conn.execute(
            f"UPDATE alerts SET {', '.join(f'{k} = ?' for k in vals)} WHERE id = ?",
            (*vals.values(), alert_id),
        )
    conn.commit()
    return alert_id


def delete_alert(conn: Connection, alert_id: int) -> None:
    # alert_hits cascades on the foreign key, but delete it explicitly so the
    # behaviour does not depend on the constraint being present.
    conn.execute("DELETE FROM alert_hits WHERE alert_id = ?", (alert_id,))
    conn.execute("DELETE FROM alerts WHERE id = ?", (alert_id,))
    conn.commit()


def record_hits(conn: Connection, alert_id: int,
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
                "VALUES (?,?,?,?,?,false)", (alert_id, key, price, now, now))
    gone = set(existing) - set(hits)
    if gone:
        conn.executemany(
            "DELETE FROM alert_hits WHERE alert_id = ? AND trip_key = ?",
            [(alert_id, k) for k in gone])
    conn.commit()
    unseen = conn.execute(
        "SELECT COUNT(*) FROM alert_hits WHERE alert_id = ? AND seen = false", (alert_id,)
    ).fetchone()[0]
    return new_keys, unseen


def unseen_keys(conn: Connection, alert_id: int) -> set[str]:
    return {r["trip_key"] for r in conn.execute(
        "SELECT trip_key FROM alert_hits WHERE alert_id = ? AND seen = false", (alert_id,))}


def mark_alert_seen(conn: Connection, alert_id: int | None = None) -> None:
    if alert_id is None:
        conn.execute("UPDATE alert_hits SET seen = true")
    else:
        conn.execute("UPDATE alert_hits SET seen = true WHERE alert_id = ?", (alert_id,))
    conn.commit()
