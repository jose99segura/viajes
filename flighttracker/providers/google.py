"""Google Flights prices via the `fast-flights` library (optional, v3 API).

Google Flights has no public API; fast-flights speaks the same protobuf
protocol the website uses, which is far more stable than driving a browser.
This provider covers airlines Ryanair's API can't see (e.g. Luxair LUX-ALC).
It is slower, so we only query a shortlist of specific dates.
"""
from __future__ import annotations

import re
from datetime import date

try:
    from fast_flights import FlightQuery, Passengers, create_query
    from fast_flights.parser import parse
    from primp import Client

    AVAILABLE = True
except ImportError:  # pragma: no cover
    AVAILABLE = False

# From EU IPs Google serves a cookie-consent interstitial instead of results;
# these cookies mark consent as already given (minimal/rejected tracking).
_CONSENT_COOKIES = "CONSENT=YES+; SOCS=CAISHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiA_LyaBg"
_URL = "https://www.google.com/travel/flights"

_PRICE_RE = re.compile(r"(\d+[\d.,]*)")


def _parse_price(value) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    m = _PRICE_RE.search(str(value or ""))
    if not m:
        return None
    return float(m.group(1).replace(",", ""))


def fetch_day(origin: str, destination: str, day: date, currency: str) -> list[dict]:
    if not AVAILABLE:
        return []
    query = create_query(
        flights=[
            FlightQuery(
                date=day.isoformat(),
                from_airport=origin.upper(),
                to_airport=destination.upper(),
            )
        ],
        trip="one-way",
        seat="economy",
        passengers=Passengers(adults=1),
        currency=currency,
    )
    client = Client(
        impersonate="chrome_145",
        impersonate_os="macos",
        referer=True,
        cookie_store=True,
        headers={"Cookie": _CONSENT_COOKIES},
    )
    res = client.get(_URL, params=query.params())
    try:
        result = parse(res.text)
    except (TypeError, AttributeError):
        # Google returns an empty payload when it has no itineraries for the
        # day (route not flown then, or beyond the booking horizon).
        return []
    fares: list[dict] = []
    for flight in result:
        price = _parse_price(getattr(flight, "price", None))
        legs = getattr(flight, "flights", None) or []
        if not price or not legs:
            continue
        departure = _leg_dt(legs[0].departure)
        if departure is None:
            continue
        arrival = _leg_dt(legs[-1].arrival)
        airlines = list(dict.fromkeys(getattr(flight, "airlines", []) or []))
        fares.append(
            {
                "source": "google",
                "origin": origin.upper(),
                "destination": destination.upper(),
                "departure": departure,
                "arrival": arrival,
                "airline": " + ".join(airlines) or None,
                "stops": len(legs) - 1,
                "price": price,
                "currency": currency,
                "sold_out": False,
            }
        )
    return fares


def _leg_dt(point) -> str | None:
    """fast-flights leg endpoints hold date=(y,m,d) and time=(h,m) tuples."""
    try:
        y, mo, d = point.date
        h, mi = point.time
        return f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:00"
    except Exception:  # noqa: BLE001
        return None
