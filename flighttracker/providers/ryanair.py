"""Cheapest-per-day fares from Ryanair's public fare-finder API.

This is the same API the ryanair.com fare map uses. It returns, for each day
of a month, the cheapest available fare on a route (with exact departure and
arrival times). Only covers routes Ryanair actually flies.
"""
from __future__ import annotations

from datetime import date

import requests

API = (
    "https://www.ryanair.com/api/farfnd/v4/oneWayFares/"
    "{origin}/{destination}/cheapestPerDay"
)
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/json",
}


def _month_starts(months_ahead: int) -> list[date]:
    today = date.today()
    months = []
    year, month = today.year, today.month
    for _ in range(months_ahead):
        months.append(date(year, month, 1))
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return months


def fetch(origin: str, destination: str, months_ahead: int, currency: str) -> list[dict]:
    fares: list[dict] = []
    session = requests.Session()
    for month_start in _month_starts(months_ahead):
        url = API.format(origin=origin.upper(), destination=destination.upper())
        resp = session.get(
            url,
            params={
                "outboundMonthOfDate": month_start.isoformat(),
                "currency": currency,
            },
            headers=HEADERS,
            timeout=30,
        )
        if resp.status_code == 404:
            # Route not operated by Ryanair
            return []
        resp.raise_for_status()
        payload = resp.json()
        for fare in payload.get("outbound", {}).get("fares", []):
            if fare.get("unavailable") or fare.get("price") is None:
                continue
            fares.append(
                {
                    "source": "ryanair",
                    "origin": origin.upper(),
                    "destination": destination.upper(),
                    "departure": fare["departureDate"],
                    "arrival": fare.get("arrivalDate"),
                    "airline": "Ryanair",
                    "stops": 0,  # Ryanair fare-finder only returns non-stop
                    "price": float(fare["price"]["value"]),
                    "currency": fare["price"].get("currencyCode", currency),
                    "sold_out": bool(fare.get("soldOut")),
                }
            )
    return fares
