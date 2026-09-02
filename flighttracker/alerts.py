"""Alert rules: saved trip filters that are re-evaluated against the latest
snapshot after every fetch, remembering which matches are new."""
from __future__ import annotations

import sqlite3

from . import db
from .config import Config
from .trips import TripFilter, build_trips, trip_key

MAX_MATCHES = 30

# Sensible starting rules, created once when the table is empty. They encode
# the usual ask — weekend trips to Alicante, willing to take a day off if the
# price is right — and are meant to be edited, not kept.
DEFAULT_ALERTS = [
    {"name": "Finde sin días libres", "airport": None, "max_price": 120,
     "max_days_off": 0, "min_nights": 1, "max_nights": 3, "direct_only": 1},
    {"name": "Finde largo (1 día libre)", "airport": None, "max_price": 110,
     "max_days_off": 1, "min_nights": 2, "max_nights": 4, "direct_only": 1},
    {"name": "LUX directo, lo que sea", "airport": "LUX", "max_price": 130,
     "max_days_off": None, "min_nights": 2, "max_nights": 14, "direct_only": 1},
    {"name": "Chollo absoluto", "airport": None, "max_price": 70,
     "max_days_off": None, "min_nights": 1, "max_nights": 21, "direct_only": 0},
]


def seed_defaults(conn: sqlite3.Connection) -> bool:
    if db.list_alerts(conn):
        return False
    for a in DEFAULT_ALERTS:
        db.save_alert(conn, a)
    return True


def filter_for(alert: sqlite3.Row | dict) -> TripFilter:
    return TripFilter(
        min_nights=int(alert["min_nights"] or 1),
        max_nights=int(alert["max_nights"] or 21),
        airport=(alert["airport"] or "").upper(),
        direct_only=bool(alert["direct_only"]),
        max_price=alert["max_price"],
        max_days_off=alert["max_days_off"],
    )


def evaluate(cfg: Config, conn: sqlite3.Connection | None = None,
             record: bool = True) -> list[dict]:
    """Run every enabled alert. With record=True (a fetch) hits are stored so
    the next run can tell what is new; with record=False (the UI) the stored
    unseen state is only read."""
    own = conn is None
    conn = conn or db.connect()
    try:
        seed_defaults(conn)
        results = []
        for alert in db.list_alerts(conn):
            entry = {"alert": dict(alert), "matches": [], "new_keys": [],
                     "unseen": 0, "total": 0}
            if alert["enabled"]:
                combos, _ = build_trips(cfg, filter_for(alert))
                combos.sort(key=lambda c: (c["price"], c["days_off"]))
                entry["total"] = len(combos)
                top = combos[:MAX_MATCHES]
                keys = {trip_key(c): c["price"] for c in top}
                if record:
                    new, unseen = db.record_hits(conn, alert["id"], keys)
                    entry["new_keys"] = sorted(new)
                    entry["unseen"] = unseen
                else:
                    unseen = db.unseen_keys(conn, alert["id"])
                    entry["unseen"] = len(unseen & set(keys))
                unseen_set = set(entry["new_keys"]) if record else unseen
                for c in top:
                    c["key"] = trip_key(c)
                    c["is_new"] = c["key"] in unseen_set
                entry["matches"] = top
            results.append(entry)
        return results
    finally:
        if own:
            conn.close()
