from __future__ import annotations

import dataclasses
import os
from datetime import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.yaml"
# Read in this order, first definition wins: the real environment, then
# .env, then .env.local. Next.js reads the same two files, so one
# DATABASE_URL in either serves both the dashboard and the fetcher.
ENV_PATHS = (ROOT / ".env", ROOT / ".env.local")
# The database is Postgres now; the connection string comes from
# DATABASE_URL. prices.db survives only as the import source for
# scripts/import_sqlite.py.


def load_env(paths: tuple[Path, ...] = ENV_PATHS) -> None:
    """Load KEY=VALUE lines from the env files into os.environ (real env wins)."""
    for path in paths:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip("'\"")
            if key and value and key not in os.environ:
                os.environ[key] = value


@dataclasses.dataclass
class Scoring:
    work_hours_penalty: float
    work_start: time
    work_end: time
    weekday_penalty: float
    friday_evening_bonus: float
    weekend_bonus: float
    before_hour: time
    early_penalty: float
    late_hour: time
    late_arrival_penalty: float
    day_off_cost: float


@dataclasses.dataclass
class Airport:
    """What it takes to reach one of the home airports by car, one way."""
    km: float
    drive_minutes: float
    parking_per_day: float


@dataclasses.dataclass
class Travel:
    """Ground costs: the part of a trip the airline does not charge you for."""
    eur_per_km: float
    eur_per_hour: float
    airports: dict[str, Airport]


@dataclasses.dataclass
class GoogleSampling:
    weeks: int
    weekdays: list[int]


@dataclasses.dataclass
class LuxairSampling:
    routes: list[tuple[str, str]]
    nights: list[int]


@dataclasses.dataclass
class Config:
    routes: list[dict]
    months_ahead: int
    currency: str
    scoring: Scoring
    travel: Travel
    google: GoogleSampling
    luxair: LuxairSampling


def _parse_time(value: str) -> time:
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


def load_config(path: Path = CONFIG_PATH) -> Config:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    s = raw["scoring"]
    g = raw.get("google", {})
    lx = raw.get("luxair", {})
    tr = raw.get("travel", {})
    return Config(
        google=GoogleSampling(
            weeks=int(g.get("weeks", 6)),
            weekdays=list(g.get("weekdays", [4, 5, 6])),
        ),
        luxair=LuxairSampling(
            routes=[tuple(r) for r in lx.get("routes", [])],
            nights=list(lx.get("nights", [3, 7, 14])),
        ),
        travel=Travel(
            eur_per_km=float(tr.get("eur_per_km", 0.0)),
            eur_per_hour=float(tr.get("eur_per_hour", 0.0)),
            airports={
                code.upper(): Airport(
                    km=float(a.get("km", 0)),
                    drive_minutes=float(a.get("drive_minutes", 0)),
                    parking_per_day=float(a.get("parking_per_day", 0)),
                )
                for code, a in (tr.get("airports") or {}).items()
            },
        ),
        routes=raw["routes"],
        months_ahead=int(raw.get("months_ahead", 3)),
        currency=raw.get("currency", "EUR"),
        scoring=Scoring(
            work_hours_penalty=float(s["work_hours_penalty"]),
            work_start=_parse_time(s["work_start"]),
            work_end=_parse_time(s["work_end"]),
            weekday_penalty=float(s["weekday_penalty"]),
            friday_evening_bonus=float(s["friday_evening_bonus"]),
            weekend_bonus=float(s["weekend_bonus"]),
            before_hour=_parse_time(s["before_hour"]),
            early_penalty=float(s["early_penalty"]),
            late_hour=_parse_time(s.get("late_hour", "22:30")),
            late_arrival_penalty=float(s.get("late_arrival_penalty", 0)),
            day_off_cost=float(s.get("day_off_cost", 0)),
        ),
    )
