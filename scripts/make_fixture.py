"""Build the cross-language scoring fixture from the live database.

The fixture feeds tests/equivalence.test.ts: the same fares, packages and
filters are scored and paired by the Python implementation (which the
fetcher's alert check uses) and by the TypeScript one (which the app uses),
and the outputs must be identical. Two implementations of one formula is
the one real risk the Python/TypeScript split introduces.

Real rows rather than invented ones, so the fixture carries the shapes the
providers actually produce -- Google's multi-stop itineraries, Ryanair's
odd departure minutes, Luxair's whole-trip fares -- plus a handful of
synthetic fares sitting exactly on the scoring boundaries (09:00, 17:30,
06:30), which real data rarely hits and where an off-by-one in a `<` versus
`<=` would otherwise go unnoticed.

Run it once and commit the result; re-run only to deliberately refresh the
fixture, then regenerate expected.json with scripts/score_fixture.py.

    python scripts/make_fixture.py > tests/fixtures/fixture.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Runnable as `python scripts/<name>.py` from the repo root without
# PYTHONPATH: put the root on sys.path before importing the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flighttracker import db

# One fare in roughly every N of a route, so every route is represented
# without the pairing product exploding. ~80 legs pair into a few thousand
# combos, which is enough to exercise the sort and still diff by eye.
STRIDE = 6
MAX_PER_ROUTE = 18
MAX_PACKAGES = 40

# Departures placed on the boundaries scoring compares against. Each is a
# Monday-to-Sunday spread so the weekday branches all fire.
#   2026-10-05 Mon, 2026-10-09 Fri, 2026-10-10 Sat, 2026-10-11 Sun
BOUNDARY_FARES = [
    # Monday: exactly at work_start, one minute before, exactly at work_end
    ("HHN", "ALC", "2026-10-05T09:00:00", 0),
    ("HHN", "ALC", "2026-10-05T08:59:00", 0),
    ("HHN", "ALC", "2026-10-05T17:30:00", 0),
    ("HHN", "ALC", "2026-10-05T17:29:00", 0),
    # Monday: exactly before_hour, and one minute earlier
    ("HHN", "ALC", "2026-10-05T06:30:00", 0),
    ("HHN", "ALC", "2026-10-05T06:29:00", 0),
    # Friday: same boundaries -- the "fri evening" branch
    ("SCN", "ALC", "2026-10-09T17:30:00", 0),
    ("SCN", "ALC", "2026-10-09T17:29:00", 0),
    ("SCN", "ALC", "2026-10-09T09:00:00", 0),
    ("SCN", "ALC", "2026-10-09T08:59:00", 0),
    # Weekend red-eye: weekend bonus AND early penalty together
    ("LUX", "ALC", "2026-10-10T06:29:00", 1),
    ("LUX", "ALC", "2026-10-11T06:30:00", 2),
    # Returns on the matching days, so the boundary outbounds pair up and
    # work_days_used gets exercised across the weekend
    ("ALC", "HHN", "2026-10-05T23:55:00", 0),
    ("ALC", "HHN", "2026-10-09T17:30:00", 0),
    ("ALC", "HHN", "2026-10-11T23:59:00", 0),
    ("ALC", "HHN", "2026-10-12T00:00:00", 0),
    ("ALC", "SCN", "2026-10-12T06:00:00", 0),
    ("ALC", "LUX", "2026-10-13T12:00:00", 1),
    # Same-day return, later and earlier than the outbound (nights == 0)
    ("ALC", "HHN", "2026-10-05T10:00:00", 0),
    ("ALC", "HHN", "2026-10-05T08:00:00", 0),
]

FILTERS = [
    {"name": "default", "filter": {}},
    {"name": "weekend", "filter": {"when": "weekend"}},
    {"name": "fri", "filter": {"when": "fri"}},
    {"name": "convenient", "filter": {"when": "convenient"}},
    {"name": "weekday", "filter": {"when": "weekday"}},
    {"name": "direct", "filter": {"direct_only": True}},
    {"name": "same_airport", "filter": {"same_only": True}},
    {"name": "lux", "filter": {"airport": "LUX"}},
    {"name": "hhn_direct", "filter": {"airport": "HHN", "direct_only": True}},
    {"name": "cheap", "filter": {"max_price": 80}},
    {"name": "no_days_off", "filter": {"max_days_off": 0}},
    {"name": "one_day_off", "filter": {"max_days_off": 1, "max_price": 150}},
    {"name": "short", "filter": {"min_nights": 1, "max_nights": 3}},
    {"name": "long", "filter": {"min_nights": 7, "max_nights": 14}},
    {"name": "zero_nights", "filter": {"min_nights": 0, "max_nights": 0}},
    {"name": "everything", "filter": {
        "airport": "SCN", "when": "convenient", "direct_only": True,
        "same_only": False, "max_price": 200, "max_days_off": 1,
        "min_nights": 1, "max_nights": 4,
    }},
]


def main() -> int:
    conn = db.connect()
    try:
        snapshot = db.latest_snapshot(conn)
        packages = db.latest_packages(conn)
    finally:
        conn.close()

    by_route: dict[tuple[str, str], list[dict]] = {}
    for r in snapshot:
        by_route.setdefault((r["origin"], r["destination"]), []).append(dict(r))

    fares: list[dict] = []
    for key in sorted(by_route):
        rows = by_route[key]
        fares.extend(rows[::STRIDE][:MAX_PER_ROUTE])

    for i, (origin, dest, dep, stops) in enumerate(BOUNDARY_FARES):
        fares.append({
            "captured_at": "2026-09-06T12:00:00+00:00",
            "source": "fixture",
            "origin": origin,
            "destination": dest,
            "departure": dep,
            "arrival": None,
            "airline": "Boundary",
            "stops": stops,
            # Distinct prices so a wrong pairing cannot hide behind a tie.
            "price": 40.0 + i,
            "currency": "EUR",
            "sold_out": False,
        })

    # Drop the id: it is meaningless across databases and would only churn
    # the diff. Keep everything else the row carries.
    for f in fares:
        f.pop("id", None)
    pkgs = [{k: v for k, v in dict(p).items() if k != "id"}
            for p in packages[:MAX_PACKAGES]]

    json.dump(
        {"fares": fares, "packages": pkgs, "filters": FILTERS},
        sys.stdout, indent=1, ensure_ascii=False,
    )
    sys.stdout.write("\n")
    print(f"{len(fares)} fares, {len(pkgs)} packages, {len(FILTERS)} filters",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
