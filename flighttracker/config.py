from __future__ import annotations

import dataclasses
import os
from datetime import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.yaml"
DB_PATH = ROOT / "prices.db"
ENV_PATH = ROOT / ".env"


def load_env(path: Path = ENV_PATH) -> None:
    """Load KEY=VALUE lines from .env into os.environ (real env wins)."""
    if not path.exists():
        return
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
    return Config(
        google=GoogleSampling(
            weeks=int(g.get("weeks", 6)),
            weekdays=list(g.get("weekdays", [4, 5, 6])),
        ),
        luxair=LuxairSampling(
            routes=[tuple(r) for r in lx.get("routes", [])],
            nights=list(lx.get("nights", [3, 7, 14])),
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
        ),
    )
