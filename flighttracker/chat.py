"""Claude-backed chat that answers questions about the tracked fares.

The whole point is that Claude sees the actual database, not a vague summary:
build_context() renders the current snapshot compactly enough to fit in a
cached system prompt, so follow-up questions are cheap.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import date, datetime, timedelta

import requests

from . import db
from .config import Config, load_env
from .scoring import convenience_adjustment, work_days_used

load_env()

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.7-flash")
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "{model}:streamGenerateContent"
)
CLAUDE_MODEL = "claude-opus-5"

SYSTEM_INTRO = """You are the assistant inside "viajes", a personal flight-price
tracker. The user flies between Luxembourg-area airports (LUX, SCN, HHN) and
Alicante (ALC), and wants to know when it is cheapest and most convenient to fly.

You are given the current fare snapshot below. Answer from it — do not invent
flights, prices or dates. If the data cannot answer the question, say so and
suggest running a fetch (`python -m flighttracker fetch --google`).

Key concept: "effective cost" = ticket price + a convenience adjustment in euros
that reflects how much a departure time disrupts a normal work week. A cheap
flight that forces a day off work is not actually cheap.

Answer in Spanish.

## Response format — follow it every time

1. **Veredicto** — one bold line answering the question directly. No preamble.
2. **Las opciones** — at most 3, best first, each as a `###` heading naming the
   dates, then 2-4 bullets: ida, vuelta, precio (real + effective), and the
   catch if there is one. Always give real dates, times, airports, airlines and
   prices from the data. Never invent one.
3. **Por qué** — one or two sentences on the tradeoff. Skip if obvious.

Keep it tight — this renders in a narrow sidebar. No tables. Don't restate the
question. Don't explain the scoring system unless asked.

## Trip markers — required

Immediately after each round-trip option you name, emit a marker line, alone,
in exactly this form:

[TRIP]out_airport|out_departure_iso|return_airport|return_departure_iso

Example: [TRIP]SCN|2026-09-10T22:00:00|HHN|2026-09-13T21:25:00

For a one-way option use: [FLIGHT]origin|destination|departure_iso

For a **Luxair** round trip use its own form — it is priced as a whole trip and
has no times, so it must not use [TRIP]:
[PACKAGE]origin|destination|out_date|nights
Example: [PACKAGE]LUX|ALC|2026-11-21|14
The ISO datetimes must match the data exactly. The app turns these into
clickable cards the user can save — an option without a marker cannot be saved,
so never omit it. Do not describe the markers or wrap them in code fences.

Mention non-stop vs. connections when it matters — LUX routes are usually
connections, HHN/SCN are Ryanair non-stop."""


def _fmt_dt(iso: str) -> str:
    try:
        d = datetime.fromisoformat(iso)
    except ValueError:
        return iso
    return d.strftime("%a %d %b %H:%M")


def build_context(cfg: Config, max_trips: int = 60, max_legs: int = 60) -> str:
    """Render the current snapshot as compact text for the system prompt."""
    conn = db.connect()
    try:
        rows = db.latest_snapshot(conn)
        packages = db.latest_packages(conn)
        captures = conn.execute(
            "SELECT COUNT(DISTINCT captured_at) n, MIN(captured_at) a,"
            " MAX(captured_at) b FROM fares"
        ).fetchone()
    finally:
        conn.close()

    s = cfg.scoring
    parts = [
        "# Scoring weights (euros)",
        f"work-hours departure (Mon-Fri {s.work_start}-{s.work_end}): +{s.work_hours_penalty:.0f}",
        f"weekday (Mon-Thu) departure: +{s.weekday_penalty:.0f}",
        f"Friday after {s.work_end}: -{s.friday_evening_bonus:.0f}",
        f"Saturday/Sunday: -{s.weekend_bonus:.0f}",
        f"before {s.before_hour}: +{s.early_penalty:.0f}",
        "",
        f"# Snapshot history: {captures['n']} captures, "
        f"from {captures['a']} to {captures['b']} (UTC)",
        "",
    ]

    outbound, inbound = [], []
    by_route: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        try:
            dep = datetime.fromisoformat(r["departure"])
        except ValueError:
            continue
        adj, label = convenience_adjustment(dep, s)
        leg = {
            "origin": r["origin"], "destination": r["destination"],
            "dep": dep, "departure": r["departure"],
            "airline": r["airline"] or "?", "stops": r["stops"],
            "price": r["price"], "effective": r["price"] + adj, "label": label,
        }
        by_route[f"{r['origin']}->{r['destination']}"].append(r["price"])
        (outbound if r["destination"] == "ALC" else inbound).append(leg)

    parts.append("# Routes tracked (price range of current snapshot)")
    for route, prices in sorted(by_route.items()):
        parts.append(
            f"{route}: {len(prices)} fares, {min(prices):.0f}-{max(prices):.0f} EUR"
        )
    parts.append("")

    def render(legs: list[dict], title: str, limit: int) -> None:
        legs = sorted(legs, key=lambda x: x["effective"])[:limit]
        parts.append(f"# {title} (best {len(legs)} by effective cost)")
        parts.append("route | departure | airline | stops | price | effective | when")
        for x in legs:
            parts.append(
                f"{x['origin']}->{x['destination']} | {_fmt_dt(x['departure'])} | "
                f"{x['airline']} | {x['stops']} | {x['price']:.2f} | "
                f"{x['effective']:.2f} | {x['label']}"
            )
        parts.append("")

    render(outbound, "Outbound legs to ALC", max_legs)
    render(inbound, "Return legs from ALC", max_legs)

    # Best round trips, so Claude can answer "when should I go" directly.
    combos = []
    for out in outbound:
        for ret in inbound:
            nights = (ret["dep"].date() - out["dep"].date()).days
            if nights < 1 or nights > 21:
                continue
            combos.append(
                (out["effective"] + ret["effective"], out, ret, nights)
            )
    # Luxair sells LUX-ALC as a whole round trip with no departure times, so
    # it cannot be paired leg-by-leg like the rest.
    if packages:
        pkgs = sorted(packages, key=lambda p: p["price"])[:40]
        parts.append(
            "# Luxair non-stop round trips (LUX-ALC, whole-trip price, "
            "NO departure times published — dates only). These are the only "
            "non-stop LUX options; Google's LUX itineraries all have "
            "connections."
        )
        parts.append("route | out date | nights | return date | price (round trip)")
        for p in pkgs:
            out_day = date.fromisoformat(p["out_date"])
            back = out_day + timedelta(days=p["nights"])
            parts.append(
                f"{p['origin']}->{p['destination']} | {out_day:%a %d %b %Y} | "
                f"{p['nights']} | {back:%a %d %b %Y} | {p['price']:.2f}"
            )
        parts.append("")

    combos.sort(key=lambda c: c[0])
    parts.append(f"# Best round trips (top {min(max_trips, len(combos))} by effective cost)")
    parts.append("out | departure | back | return | nights | work days off | price | effective")
    for eff, out, ret, nights in combos[:max_trips]:
        days_off = work_days_used(datetime.fromisoformat(out["departure"]),
                                  datetime.fromisoformat(ret["departure"]), cfg.scoring)
        parts.append(
            f"{out['origin']}->ALC | {_fmt_dt(out['departure'])} | "
            f"ALC->{ret['destination']} | {_fmt_dt(ret['departure'])} | {nights} | "
            f"{days_off} | {out['price'] + ret['price']:.2f} | {eff:.2f}"
        )
    parts.append("")
    parts.append(
        "'work days off' = Mon-Fri days the user would need off work for that trip "
        "(a Friday departure after 17:30 costs none; any weekday return day counts). "
        "The user strongly prefers 0, accepts 1 (Friday or Monday) for a good "
        "price, and more only for a real bargain. Always state this number when "
        "recommending a trip."
    )
    return "\n".join(parts)


class MissingCredentials(RuntimeError):
    pass


def provider() -> tuple[str, str]:
    """Which LLM backend is configured: ('gemini'|'claude', model)."""
    load_env()
    if os.environ.get("GEMINI_API_KEY"):
        return "gemini", GEMINI_MODEL
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "claude", CLAUDE_MODEL
    raise MissingCredentials(
        "Falta la API key. Pega tu clave de Gemini en el archivo .env "
        "(GEMINI_API_KEY=...) y reinicia el servidor."
    )


def stream_reply(cfg: Config, messages: list[dict]):
    """Yield text chunks of the assistant's reply. Raises MissingCredentials."""
    name, model = provider()
    system = f"{SYSTEM_INTRO}\n\n{build_context(cfg)}"
    if name == "gemini":
        yield from _stream_gemini(model, system, messages)
    else:
        yield from _stream_claude(model, system, messages)


def list_gemini_models() -> list[str]:
    """Model IDs this API key can actually use for text generation."""
    load_env()
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise MissingCredentials("Falta GEMINI_API_KEY en .env")
    resp = requests.get(
        "https://generativelanguage.googleapis.com/v1beta/models",
        params={"key": key, "pageSize": 200}, timeout=60,
    )
    resp.raise_for_status()
    return [
        m["name"].removeprefix("models/")
        for m in resp.json().get("models", [])
        if "generateContent" in m.get("supportedGenerationMethods", [])
    ]


def _stream_gemini(model: str, system: str, messages: list[dict]):
    """Stream from the Gemini REST API.

    Uses REST rather than the google-genai SDK: that SDK pulls in
    `cryptography`, which has no prebuilt wheel for Windows ARM64 and fails to
    compile there. REST needs only `requests`, which we already depend on.
    """
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [
            {
                "role": "model" if m["role"] == "assistant" else "user",
                "parts": [{"text": m["content"]}],
            }
            for m in messages
        ],
        "generationConfig": {"maxOutputTokens": 8000},
    }
    resp = requests.post(
        GEMINI_URL.format(model=model),
        params={"alt": "sse", "key": os.environ["GEMINI_API_KEY"]},
        json=body,
        stream=True,
        timeout=180,
    )
    if resp.status_code != 200:
        detail = resp.text[:400]
        if resp.status_code == 404:
            detail = (f"El modelo '{model}' no existe o no está disponible para tu "
                      f"clave. Cambia GEMINI_MODEL en .env. ({detail})")
        raise RuntimeError(f"Gemini {resp.status_code}: {detail}")

    # Decode as UTF-8 explicitly: requests defaults text/* without an explicit
    # charset to ISO-8859-1, which mangles "€" and "→" into mojibake.
    for raw_line in resp.iter_lines(decode_unicode=False):
        if not raw_line:
            continue
        line = raw_line.decode("utf-8", errors="replace")
        if not line.startswith("data: "):
            continue
        payload = line[6:].strip()
        if payload == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue
        for cand in chunk.get("candidates", []):
            for part in cand.get("content", {}).get("parts", []):
                if part.get("text"):
                    yield part["text"]


def _stream_claude(model: str, system: str, messages: list[dict]):
    import anthropic

    client = anthropic.Anthropic()
    with client.messages.stream(
        model=model,
        max_tokens=8000,
        system=[{"type": "text", "text": system,
                 "cache_control": {"type": "ephemeral"}}],
        messages=messages,
    ) as stream:
        for text in stream.text_stream:
            yield text
