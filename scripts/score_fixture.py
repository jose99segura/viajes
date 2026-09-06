"""Score the equivalence fixture with the Python implementation.

This is the oracle side of tests/equivalence.test.ts. It runs the very
functions the fetcher's alert check runs -- scoring.convenience_adjustment,
scoring.day_adjustment, scoring.work_days_used and trips.build_trips -- over
tests/fixtures/fixture.json, and writes what they produce. The TypeScript
test then scores the same fixture and asserts identical output.

Nothing here is reimplemented: build_trips reads through the db module, so
the db module is pointed at the fixture instead of Postgres. Anything else
would be testing a copy of the logic rather than the logic.

    python scripts/score_fixture.py > tests/fixtures/expected.json
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime
from pathlib import Path

# Runnable as `python scripts/<name>.py` from the repo root without
# PYTHONPATH: put the root on sys.path before importing the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flighttracker import db, trips
from flighttracker.config import load_config
from flighttracker.scoring import (
    convenience_adjustment,
    day_adjustment,
    work_days_used,
)

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "fixture.json"


class _FixtureConnection:
    def close(self) -> None:
        pass


def main() -> int:
    cfg = load_config()
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    fares = [db.Row(f) for f in fixture["fares"]]
    packages = [db.Row(p) for p in fixture["packages"]]

    # Point build_trips at the fixture. It calls these three by attribute on
    # the module, so patching the module is enough.
    db.connect = lambda url=None: _FixtureConnection()  # type: ignore[assignment]
    db.latest_snapshot = lambda conn: fares  # type: ignore[assignment]
    db.latest_packages = lambda conn: packages  # type: ignore[assignment]

    legs = []
    for f in fares:
        dep = datetime.fromisoformat(f["departure"])
        adj, label = convenience_adjustment(dep, cfg.scoring)
        legs.append({
            "departure": f["departure"],
            "adjustment": adj,
            "label": label,
        })

    package_days = []
    for p in packages:
        out_day = date.fromisoformat(p["out_date"])
        adj, label = day_adjustment(out_day, cfg.scoring)
        package_days.append({
            "out_date": p["out_date"],
            "adjustment": adj,
            "label": label,
        })

    # work_days_used on its own, over every outbound/return pair of the
    # boundary fares, so a wrong day count is attributed to that function
    # rather than surfacing as a mismatched trip somewhere in a filter.
    boundary = [f for f in fares if f["source"] == "fixture"]
    outs = [f for f in boundary if f["destination"] == "ALC"]
    rets = [f for f in boundary if f["origin"] == "ALC"]
    days_off = []
    for o in outs:
        for r in rets:
            od = datetime.fromisoformat(o["departure"])
            rd = datetime.fromisoformat(r["departure"])
            if rd < od:
                continue
            days_off.append({
                "out": o["departure"],
                "ret": r["departure"],
                "days": work_days_used(od, rd, cfg.scoring),
                "days_date_only": work_days_used(od, rd, cfg.scoring, True, True),
            })

    results = []
    for entry in fixture["filters"]:
        f = trips.TripFilter(**entry["filter"])
        combos, last_captured = trips.build_trips(cfg, f)
        results.append({
            "name": entry["name"],
            "last_captured": last_captured,
            "count": len(combos),
            "trips": [
                {
                    "key": trips.trip_key(c),
                    "nights": c["nights"],
                    "days_off": c["days_off"],
                    "same_airport": c["same_airport"],
                    "package": bool(c.get("package")),
                    "price": c["price"],
                    "adjustment": c["adjustment"],
                    "effective": c["effective"],
                    "out_label": c["out"]["label"],
                    "ret_label": c["ret"]["label"],
                    "out_adjustment": c["out"]["adjustment"],
                    "ret_adjustment": c["ret"]["adjustment"],
                }
                for c in combos
            ],
        })

    json.dump(
        {
            "legs": legs,
            "package_days": package_days,
            "days_off": days_off,
            "filters": results,
        },
        sys.stdout, indent=1, ensure_ascii=False,
    )
    sys.stdout.write("\n")
    total = sum(r["count"] for r in results)
    print(f"{len(legs)} legs, {len(package_days)} package days, "
          f"{len(days_off)} day counts, {total} trips across "
          f"{len(results)} filters", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
