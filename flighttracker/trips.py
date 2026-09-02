"""Round-trip assembly: pair outbound legs (X->ALC) with return legs (ALC->X),
score each pairing, and mix in Luxair's whole-trip fares.

Shared by the web API, the alert evaluator and the chat context so that all
three agree on what "a trip" is and what it costs.
"""
from __future__ import annotations

import dataclasses
from datetime import date, datetime, timedelta

from . import db
from .config import Config
from .scoring import convenience_adjustment, day_adjustment, work_days_used


@dataclasses.dataclass
class TripFilter:
    min_nights: int = 1
    max_nights: int = 21
    airport: str = ""          # home airport (LUX/SCN/HHN); "" = any
    when: str = ""             # "", "weekend", "fri", "convenient", "weekday"
    same_only: bool = False    # return to the same airport you left from
    direct_only: bool = False
    max_price: float | None = None
    max_days_off: int | None = None   # work days the trip may consume


def matches_when(label: str, when: str) -> bool:
    if not when:
        return True
    if when == "weekend":
        return "weekend" in label
    if when == "fri":
        return "fri evening" in label
    if when == "convenient":
        return "weekend" in label or "fri evening" in label
    if when == "weekday":
        return "weekday" in label or "work hours" in label
    return True


def trip_key(combo: dict) -> str:
    """Stable identity for a pairing, used to remember alert hits."""
    return "|".join([
        combo["out"]["origin"], combo["out"]["departure"],
        combo["ret"]["destination"], combo["ret"]["departure"],
    ])


def build_trips(cfg: Config, f: TripFilter) -> tuple[list[dict], str | None]:
    """All pairings that pass the filter, cheapest-effective first, plus the
    timestamp of the most recent capture they were built from."""
    conn = db.connect()
    try:
        rows = db.latest_snapshot(conn)
        packages = db.latest_packages(conn)
    finally:
        conn.close()

    outbounds, returns, last_captured = [], [], None
    for r in rows:
        try:
            dep = datetime.fromisoformat(r["departure"])
        except ValueError:
            continue
        adj, label = convenience_adjustment(dep, cfg.scoring)
        leg = {
            "origin": r["origin"], "destination": r["destination"],
            "departure": r["departure"], "airline": r["airline"],
            "stops": r["stops"],
            "price": r["price"], "adjustment": adj, "label": label,
            "source": r["source"], "_dep": dep,
        }
        if last_captured is None or r["captured_at"] > last_captured:
            last_captured = r["captured_at"]
        if f.direct_only and r["stops"]:
            continue
        if r["destination"] == "ALC":
            if f.airport and r["origin"] != f.airport:
                continue
            if not matches_when(label, f.when):
                continue
            outbounds.append(leg)
        elif r["origin"] == "ALC":
            if f.airport and r["destination"] != f.airport:
                continue
            returns.append(leg)

    combos = []
    for out in outbounds:
        for ret in returns:
            nights = (ret["_dep"].date() - out["_dep"].date()).days
            if nights < f.min_nights or nights > f.max_nights:
                continue
            if nights == 0 and ret["_dep"] <= out["_dep"]:
                continue
            if f.same_only and out["origin"] != ret["destination"]:
                continue
            price = out["price"] + ret["price"]
            if f.max_price is not None and price > f.max_price:
                continue
            days_off = work_days_used(out["_dep"], ret["_dep"], cfg.scoring)
            if f.max_days_off is not None and days_off > f.max_days_off:
                continue
            combos.append({
                "out": {k: v for k, v in out.items() if k != "_dep"},
                "ret": {k: v for k, v in ret.items() if k != "_dep"},
                "nights": nights,
                "days_off": days_off,
                "same_airport": out["origin"] == ret["destination"],
                "price": round(price, 2),
                "adjustment": out["adjustment"] + ret["adjustment"],
                "effective": round(price + out["adjustment"] + ret["adjustment"], 2),
            })

    combos.extend(_package_combos(packages, cfg, f))
    combos.sort(key=lambda c: c["effective"])
    return combos, last_captured


def _package_combos(packages, cfg: Config, f: TripFilter) -> list[dict]:
    """Luxair round trips, shaped like the paired ones so the UI can mix them.

    Non-stop and quoted whole, but with no departure times, so they are scored
    on the day of week only (scoring.day_adjustment) and their days-off count
    is conservative (scoring.work_days_used with date_only=True)."""
    out = []
    for r in packages:
        if f.airport and r["origin"] != f.airport and r["destination"] != f.airport:
            continue
        if not (f.min_nights <= r["nights"] <= f.max_nights):
            continue
        if f.max_price is not None and r["price"] > f.max_price:
            continue
        try:
            out_day = date.fromisoformat(r["out_date"])
        except ValueError:
            continue
        ret_day = out_day + timedelta(days=r["nights"])
        out_adj, out_label = day_adjustment(out_day, cfg.scoring)
        ret_adj, ret_label = day_adjustment(ret_day, cfg.scoring)
        if not matches_when(out_label, f.when):
            continue
        out_dt = datetime.combine(out_day, datetime.min.time())
        ret_dt = datetime.combine(ret_day, datetime.min.time())
        days_off = work_days_used(out_dt, ret_dt, cfg.scoring, True, True)
        if f.max_days_off is not None and days_off > f.max_days_off:
            continue
        out.append({
            "out": {
                "origin": r["origin"], "destination": r["destination"],
                "departure": out_dt.isoformat(), "date_only": True,
                "airline": "Luxair", "stops": 0, "price": None,
                "adjustment": out_adj, "label": out_label, "source": "luxair",
            },
            "ret": {
                "origin": r["destination"], "destination": r["origin"],
                "departure": ret_dt.isoformat(), "date_only": True,
                "airline": "Luxair", "stops": 0, "price": None,
                "adjustment": ret_adj, "label": ret_label, "source": "luxair",
            },
            "nights": r["nights"],
            "days_off": days_off,
            "same_airport": True,
            "package": True,
            "price": r["price"],
            "adjustment": out_adj + ret_adj,
            "effective": round(r["price"] + out_adj + ret_adj, 2),
        })
    return out
