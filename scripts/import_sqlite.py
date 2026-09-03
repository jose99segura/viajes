"""One-off import of the Flask era's prices.db into Postgres.

The point of this script is the price history: `fares` is append-only, one
snapshot per fetch run, and a snapshot of a past date can never be
re-collected. Losing it would flatten every history chart.

Run it once against an empty database:

    python scripts/import_sqlite.py --sqlite prices.db

It preserves primary keys. `alert_hits.alert_id` references `alerts.id`, and
a favourite's identity is its column tuple, so renumbering would either break
the foreign key or silently duplicate saved trips. Sequences are advanced
afterwards so the next INSERT does not collide.

It verifies before it reports success: row counts, price sums, and the
departure wall clocks compared as text on both sides. That last check is the
one that matters -- see the timestamp note in src/db/schema.ts. A departure
read back an hour off would still pass a row count, and would quietly change
what the "dias libres" filter returns.

pg8000 rather than psycopg: this is a pure-Python driver needing no libpq.
The dev machine is Windows ARM64, where psycopg-binary has no wheel -- the
same constraint that already keeps `cryptography` out of the chat client.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import date, datetime
from decimal import Decimal
from urllib.parse import unquote, urlparse

import pg8000.dbapi

# Import order matters: alert_hits has a foreign key onto alerts.
TABLES = ("fares", "package_fares", "alerts", "alert_hits", "favorites")

# Columns whose SQLite integer 0/1 is a Postgres boolean.
BOOL_COLUMNS = {
    "fares": {"sold_out"},
    "alerts": {"direct_only", "enabled"},
    "alert_hits": {"seen"},
}

# Columns holding a naive local wall clock ("2026-09-03T17:20:00") and columns
# holding a UTC instant ("2026-09-01T11:22:30+00:00"). fromisoformat produces
# a naive or aware datetime accordingly, which is exactly the distinction
# `timestamp` and `timestamptz` make on the other side.
NAIVE_TS_COLUMNS = {
    "fares": {"departure", "arrival"},
    "favorites": {"out_departure", "ret_departure"},
}
AWARE_TS_COLUMNS = {
    "fares": {"captured_at"},
    "package_fares": {"captured_at"},
    "alerts": {"created_at"},
    "alert_hits": {"first_seen", "last_seen"},
    "favorites": {"created_at"},
}

DATE_COLUMNS = {"package_fares": {"out_date"}}

NUMERIC_COLUMNS = {
    "fares": {"price"},
    "package_fares": {"price"},
    "alerts": {"max_price"},
    "alert_hits": {"price"},
    "favorites": {"price_at_save"},
}

# Tables with a serial `id` whose sequence has to be advanced past the
# imported maximum. alert_hits has a composite key and no sequence.
SEQUENCES = {
    "fares": "fares_id_seq",
    "package_fares": "package_fares_id_seq",
    "alerts": "alerts_id_seq",
    "favorites": "favorites_id_seq",
}


def convert(table, column, value):
    if value is None:
        return None
    if column in BOOL_COLUMNS.get(table, ()):
        return bool(value)
    if column in NAIVE_TS_COLUMNS.get(table, ()):
        return datetime.fromisoformat(value)
    if column in AWARE_TS_COLUMNS.get(table, ()):
        return datetime.fromisoformat(value)
    if column in DATE_COLUMNS.get(table, ()):
        return date.fromisoformat(value)
    if column in NUMERIC_COLUMNS.get(table, ()):
        # str() first: Decimal(float) would carry the float's binary error
        # into a numeric(10,2) column.
        return Decimal(str(value))
    return value


def connect_postgres(url):
    parsed = urlparse(url)
    if parsed.scheme not in ("postgres", "postgresql"):
        raise SystemExit("DATABASE_URL is not a Postgres URL: %r" % url)
    return pg8000.dbapi.connect(
        user=unquote(parsed.username or ""),
        password=unquote(parsed.password or ""),
        host=parsed.hostname or "localhost",
        port=parsed.port or 5432,
        database=(parsed.path or "/").lstrip("/"),
    )


def copy_table(src, dst, table):
    rows = src.execute("SELECT * FROM %s" % table).fetchall()
    if not rows:
        return 0
    columns = list(rows[0].keys())
    quoted = ", ".join('"%s"' % c for c in columns)
    placeholders = ", ".join(["%s"] * len(columns))
    statement = 'INSERT INTO "%s" (%s) VALUES (%s)' % (table, quoted, placeholders)
    dst.cursor().executemany(
        statement,
        [tuple(convert(table, c, row[c]) for c in columns) for row in rows],
    )
    return len(rows)


def verify(src, dst, copied):
    """Compare source and target. Counts alone would miss a shifted clock."""
    cur = dst.cursor()
    failures = []

    print("%-15s%9s%10s%9s" % ("table", "sqlite", "postgres", "copied"))
    for table in TABLES:
        before = src.execute("SELECT count(*) FROM %s" % table).fetchone()[0]
        cur.execute('SELECT count(*) FROM "%s"' % table)
        after = cur.fetchone()[0]
        bad = not (before == after == copied[table])
        if bad:
            failures.append(
                "%s: %d in SQLite, %d in Postgres" % (table, before, after)
            )
        print("%-15s%9d%10d%9d%s"
              % (table, before, after, copied[table], "  MISMATCH" if bad else ""))

    # Money: a numeric/float rounding slip would show up here.
    for table in ("fares", "package_fares"):
        before = src.execute(
            "SELECT round(sum(price), 2) FROM %s" % table
        ).fetchone()[0]
        cur.execute('SELECT sum(price) FROM "%s"' % table)
        after = cur.fetchone()[0]
        if Decimal(str(before)) != Decimal(after):
            failures.append("%s.price sum: %s vs %s" % (table, before, after))
        print("  %s.price sum: %s -> %s" % (table, before, after))

    # Wall clocks compared as text: this is what would catch a departure
    # silently moved by a time zone conversion. Every distinct value, not just
    # the extremes -- a uniform shift would move min and max together.
    src_all = {r[0] for r in src.execute("SELECT DISTINCT departure FROM fares")}
    cur.execute("SELECT DISTINCT departure FROM fares")
    dst_all = {r[0].isoformat() for r in cur.fetchall()}
    if src_all != dst_all:
        failures.append("%d departure wall clocks differ" % len(src_all ^ dst_all))
    print("  distinct departures identical: %s (%d values, %s..%s)"
          % (src_all == dst_all, len(src_all), min(src_all), max(src_all)))

    if failures:
        print("\nFAILED:")
        for f in failures:
            print("  - %s" % f)
        return False
    print("\nAll checks passed.")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", default="prices.db", help="path to prices.db")
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL"),
        help="target Postgres (defaults to $DATABASE_URL)",
    )
    parser.add_argument(
        "--truncate",
        action="store_true",
        help="empty the target tables first. Without it the script refuses to "
        "run against a non-empty database rather than double-import history.",
    )
    args = parser.parse_args()

    if not args.database_url:
        raise SystemExit("No target: pass --database-url or set DATABASE_URL.")
    if not os.path.exists(args.sqlite):
        raise SystemExit("No SQLite database at %s" % args.sqlite)

    src = sqlite3.connect(args.sqlite)
    src.row_factory = sqlite3.Row
    dst = connect_postgres(args.database_url)

    try:
        cur = dst.cursor()
        occupied = []
        for table in TABLES:
            cur.execute('SELECT count(*) FROM "%s"' % table)
            if cur.fetchone()[0]:
                occupied.append(table)
        if occupied and not args.truncate:
            raise SystemExit(
                "Target already holds rows in: %s.\n"
                "Re-running would double the price history. Pass --truncate "
                "to replace it deliberately." % ", ".join(occupied)
            )
        if args.truncate:
            # One statement, so the foreign key never sees a half-empty state.
            cur.execute(
                'TRUNCATE "%s" RESTART IDENTITY CASCADE' % '", "'.join(TABLES)
            )

        copied = {table: copy_table(src, dst, table) for table in TABLES}

        for table, sequence in SEQUENCES.items():
            # `false` so the next value IS max(id) + 1 rather than max(id) + 2,
            # and coalesce so an empty table leaves the sequence at 1.
            cur.execute(
                "SELECT setval('%s', coalesce((SELECT max(id) FROM \"%s\"), 0) + 1,"
                " false)" % (sequence, table)
            )

        dst.commit()
        ok = verify(src, dst, copied)
    finally:
        src.close()
        dst.close()

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
