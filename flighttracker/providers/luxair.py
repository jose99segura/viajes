"""Luxair / LuxairTours round-trip fares from the luxair.lu "instant search" API.

This is the API behind the price calendar on luxair.lu. It is the only
headless source for LUX-ALC: Ryanair doesn't fly it, and Google Flights shows
no non-stop option. Luxair operates it year-round as a LuxairTours leisure
route (typically Wed + Sat, plus Mon in peak summer).

Two important differences from the other providers:

* It quotes a **round trip as a single price** for a given departure date and
  trip length — there is no per-leg fare to pair up.
* It carries **no departure times**, only dates. The deep Amadeus availability
  API that has them sits behind Imperva bot protection, so times are not
  obtainable headlessly. Since the route flies at most once a day, a date is
  still actionable.

So these fares live in their own `package_fares` table rather than in `fares`.
"""
from __future__ import annotations

from datetime import date

import requests

from .. import retry

BASE = "https://api.luxair.lu/instantsearch"
HEADERS = {
    # Public key from the luxair.lu JS bundle. The endpoint answers without it,
    # but sending it keeps us looking like the site's own client.
    "x-api-key": "7ebd0e8c-bda1-408a-9bcd-057b3d5493ac",
    "Accept": "application/json",
    "Origin": "https://www.luxair.lu",
    "Referer": "https://www.luxair.lu/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36",
}


def durations(origin: str, destination: str) -> list[int]:
    """Trip lengths (nights) that are actually sellable on the route."""
    resp = retry.get(
        requests.Session(),
        f"https://api.luxair.lu/luxair/calendar/{origin.upper()}/"
        f"{destination.upper()}/1/durations",
        headers=HEADERS, timeout=30,
    )
    if resp.status_code != 200:
        return []
    return [int(d) for d in resp.json().get("durations", [])]


def _month_starts(months_ahead: int) -> list[str]:
    today = date.today()
    out, year, month = [], today.year, today.month
    for _ in range(months_ahead):
        out.append(date(year, month, 1).isoformat())
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return out


def fetch(
    origin: str,
    destination: str,
    months_ahead: int,
    nights: list[int],
    currency: str = "EUR",
) -> list[dict]:
    """Cheapest round-trip fare per (departure date, trip length)."""
    session = requests.Session()
    fares: list[dict] = []
    for stay in nights:
        for month in _month_starts(months_ahead):
            resp = retry.get(
                session,
                f"{BASE}/by-day",
                params={
                    "origin": origin.upper(),
                    "destination": destination.upper(),
                    "duration": stay,
                    "date": month,
                },
                headers=HEADERS,
                timeout=30,
            )
            if resp.status_code != 200:
                continue
            for entry in resp.json().get("prices", []):
                try:
                    price = float(entry["price"])
                except (KeyError, TypeError, ValueError):
                    continue
                fares.append(
                    {
                        "source": "luxair",
                        "origin": origin.upper(),
                        "destination": destination.upper(),
                        "out_date": entry["date"],
                        "nights": stay,
                        "price": price,
                        "currency": currency,
                    }
                )
    return fares
