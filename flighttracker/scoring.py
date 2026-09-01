from __future__ import annotations

from datetime import datetime

from .config import Scoring

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


def effective_cost(price: float, departure: datetime, s: Scoring) -> float:
    adj, _ = convenience_adjustment(departure, s)
    return price + adj
