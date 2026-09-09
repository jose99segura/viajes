from __future__ import annotations

from datetime import datetime

from .config import Airport, Scoring, Travel

FRIDAY = 4
SATURDAY = 5
SUNDAY = 6


def convenience_adjustment(departure: datetime, s: Scoring) -> tuple[float, str]:
    """Euros to add to (or subtract from) the price based on how much the
    departure time disrupts a normal work week. Returns (adjustment, label)."""
    adj = 0.0
    labels: list[str] = []
    wd = departure.weekday()
    t = departure.time()

    if wd in (SATURDAY, SUNDAY):
        adj -= s.weekend_bonus
        labels.append("weekend")
    elif wd == FRIDAY:
        if t >= s.work_end:
            adj -= s.friday_evening_bonus
            labels.append("fri evening")
        elif s.work_start <= t < s.work_end:
            adj += s.work_hours_penalty
            labels.append("work hours")
    else:  # Mon-Thu
        adj += s.weekday_penalty
        labels.append("weekday")
        if s.work_start <= t < s.work_end:
            adj += s.work_hours_penalty
            labels.append("work hours")

    if t < s.before_hour:
        adj += s.early_penalty
        labels.append("early")

    return adj, ", ".join(labels) or "ok"


def day_adjustment(day, s: Scoring) -> tuple[float, str]:
    """Convenience adjustment when only the date is known, not the time
    (Luxair quotes fares per date). Applies the weekday/weekend part of the
    scoring and skips everything that depends on the clock — so these fares
    are never penalised for a work-hours departure we can't actually see."""
    wd = day.weekday()
    if wd in (SATURDAY, SUNDAY):
        return -s.weekend_bonus, "weekend"
    if wd == FRIDAY:
        return 0.0, "friday"
    return s.weekday_penalty, "weekday"


def arrival_adjustment(arrival: datetime | None, at_home: bool,
                       s: Scoring) -> tuple[float, str]:
    """Penalty for landing back near Luxembourg at night: the flight ends at
    the airport, the day ends after an hour or two of driving. Only counted at
    the home end -- a midnight landing in Alicante costs you nothing -- and
    only when the provider publishes an arrival time (Luxair does not)."""
    if arrival is None or not at_home or not s.late_arrival_penalty:
        return 0.0, ""
    t = arrival.time()
    if t >= s.late_hour or t < s.before_hour:
        return s.late_arrival_penalty, "late arrival"
    return 0.0, ""


def _fmt_hours(minutes: float) -> str:
    h, m = divmod(int(round(minutes)), 60)
    return f"{h}h{m:02d}" if h else f"{m} min"


def airport_ground(code: str, t: Travel,
                   nights: int | None = None) -> tuple[float, str]:
    """What using this airport costs on top of the ticket: driving there and
    back (fuel, wear, tolls and your hours at the wheel) plus parking while you
    are away. `nights` is None for a single leg, where parking is unknowable.

    An airport that isn't in `travel.airports` costs nothing, so adding a route
    without measuring the drive first degrades gracefully instead of breaking.
    """
    a: Airport | None = t.airports.get((code or "").upper())
    if a is None:
        return 0.0, ""
    # Rates all zero: the ground model is switched off in config.yaml. Return
    # no label as well as no cost -- "3h30 de coche" next to +0 EUR reads as
    # a bug, and the UI hides the column when every row is zero.
    if not (t.eur_per_km or t.eur_per_hour or a.parking_per_day):
        return 0.0, ""
    drive = 2 * (a.km * t.eur_per_km + a.drive_minutes / 60 * t.eur_per_hour)
    label = f"{_fmt_hours(2 * a.drive_minutes)} de coche"
    total = drive
    if nights is not None:
        # You leave the car there the day you fly out and pick it up the day
        # you land: nights + 1 calendar days of parking.
        parking = a.parking_per_day * (nights + 1)
        total += parking
        if parking:
            label += f" + {parking:.0f} € parking"
    return round(total, 2), label


def trip_ground(out_airport: str, ret_airport: str, nights: int,
                t: Travel) -> tuple[float, str]:
    """Ground cost of a whole round trip. Normally one drive out, one back and
    parking in between. If you fly home to a different airport the car is still
    where you left it, so you pay both airports' driving: getting home from the
    one you land at, and going back for the car."""
    total, label = airport_ground(out_airport, t, nights)
    if ret_airport and ret_airport.upper() != (out_airport or "").upper():
        extra, extra_label = airport_ground(ret_airport, t)
        if extra:
            total += extra
            label += f" + {extra_label} para recoger el coche en {out_airport}"
    return round(total, 2), label


def _departure_day_counts(out_dep: datetime, s: Scoring,
                          date_only: bool = False) -> bool:
    """Whether work_days_used() charged the departure day itself."""
    if out_dep.weekday() >= SATURDAY:
        return False
    return date_only or out_dep.time() < s.work_end


def days_off_cost(days_off: int, out_dep: datetime, s: Scoring,
                  out_date_only: bool = False) -> tuple[float, str]:
    """Euros for the holiday a trip burns.

    Every Mon-Fri day it eats is charged *except the departure day*: that one
    is already priced by the work-hours and weekday penalties on the departure
    itself, and charging both would bill the same day twice. So a Friday 22:00
    to Sunday trip costs nothing, and a Wednesday to Saturday one costs the two
    days it really takes off your allowance.
    """
    if not days_off or not s.day_off_cost:
        return 0.0, ""
    charged = days_off - (1 if _departure_day_counts(out_dep, s, out_date_only) else 0)
    if charged <= 0:
        return 0.0, ""
    # Deliberately unnumbered: the charge covers fewer days than the trip's
    # days-off count (the departure day is excluded), and showing "10" next to
    # a badge saying "11" reads as a bug rather than as the rule it is.
    return round(charged * s.day_off_cost, 2), "vacaciones"


def effective_cost(price: float, departure: datetime, s: Scoring) -> float:
    adj, _ = convenience_adjustment(departure, s)
    return price + adj


def work_days_used(out_dep: datetime, ret_dep: datetime, s: Scoring,
                   out_date_only: bool = False, ret_date_only: bool = False) -> int:
    """How many Mon-Fri days you'd need off work for this trip.

    Departure day counts unless you leave after work (>= work_end). The return
    day counts whenever it is a weekday: even an early flight home lands during
    working hours. Every weekday in between counts. When only a date is known
    (Luxair) the day is counted — better to overstate a day off than to sell a
    trip as free when it isn't.
    """
    from datetime import timedelta

    days = 0
    day = out_dep.date()
    last = ret_dep.date()
    while day <= last:
        if day.weekday() < SATURDAY:
            if day == out_dep.date() and not out_date_only:
                if out_dep.time() < s.work_end:
                    days += 1
            else:
                days += 1
        day += timedelta(days=1)
    return days
