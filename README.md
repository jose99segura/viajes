# viajes — flight price tracker

Tracks flight prices between the Luxembourg-area airports (LUX / SCN / HHN) and
Alicante (ALC), stores the full price history in SQLite, and ranks **round
trips** by *effective cost*: ticket price plus a convenience adjustment in euros
(weekend and Friday-evening departures get a bonus; departures during work hours
get a penalty). A cheap flight that costs you a day off is not cheap.

## Data sources

- **Ryanair fare-finder API** (`ryanair.py`) — the public API behind the
  ryanair.com fare map. Cheapest fare per day, exact departure times, months
  ahead, fast and reliable. Covers HHN⇄ALC and SCN⇄ALC, always non-stop.
- **Google Flights** via [`fast-flights`](https://pypi.org/project/fast-flights/)
  (`google.py`) — speaks Google's own protobuf protocol (no browser scraping).
  This is the only source for LUX, where Ryanair doesn't fly. Slower, so it
  samples the weekdays configured in `google.weekdays`. Includes an EU
  cookie-consent workaround and records the number of stops.

- **Luxair** (`luxair.py`) — the price-calendar API behind luxair.lu. This is
  the only source of **non-stop LUX–ALC**: Ryanair doesn't fly it, and Google
  shows only 1–2 stop itineraries at 110 €+. Luxair operates it year-round as a
  LuxairTours route (typically Wed + Sat, plus Mon in peak summer).

  Two quirks, both handled: it quotes a **round trip as one price** for a
  departure date plus a trip length, so those fares live in their own
  `package_fares` table instead of being paired leg-by-leg; and it publishes
  **no departure times**. (The Amadeus availability API that has them sits
  behind Imperva bot protection, so times aren't obtainable headlessly. Since
  the route flies at most once a day, the date is still actionable.) The UI
  shows "sin hora" rather than inventing a time, and these fares are scored on
  day-of-week only — never penalised for a work-hours departure we can't see.

## Setup

```
pip install -r requirements.txt
```

For the chat assistant, put your API key in `.env` (everything else works
without it):

```
GEMINI_API_KEY=...
```

Get one at <https://aistudio.google.com/apikey>. The default model is
`gemini-3.7-flash`; override it with `GEMINI_MODEL` in the same file, and run
`python -m flighttracker models` to see what your key can actually use.
An `ANTHROPIC_API_KEY` works too — Gemini wins if both are set.

The Gemini client talks to the REST API rather than the `google-genai` SDK: that
SDK pulls in `cryptography`, which has no prebuilt wheel for Windows ARM64 and
fails to build there.

## Usage

```
python -m flighttracker.web                   # dashboard at http://localhost:5010
python -m flighttracker fetch                 # Ryanair only (fast, run daily)
python -m flighttracker fetch --google        # + Google Flights (needed for LUX)
python -m flighttracker report                # best flights by effective cost
python -m flighttracker report --route HHN-ALC --max-price 60
python -m flighttracker history HHN-ALC 2026-10-25   # price evolution for a day
python -m flighttracker models                # Gemini models your key can use
```

Every `fetch` run appends exactly one snapshot to `prices.db`, so the history
charts show how a fare moved over time — that's how you learn when to buy.

## Dashboard

The UI is a sidebar app: the nav collapses to icons, and the theme can be set
to light, dark or system. Both choices persist in `localStorage` and are applied
before first paint, so there is no flash on reload. `/info` documents how the
tracker works — sources, the scoring model, the data model and the known limits.

- **Ida y vuelta** — pairs every outbound leg with every return leg, scores the
  pair, and ranks by combined effective cost. Luxair's whole-trip fares are
  mixed in, tagged `paq.`. Filter by airport, nights, when you'd depart, price,
  same-airport-only and non-stop-only.
- **Solo ida** — the raw fare list, same scoring.
- **Calendario** — two months at a time, each day coloured by its cheapest fare
  (log scale, since fares cluster low with a long expensive tail). Switch
  between outbound and return; click a day to jump to the trips leaving then.
- **★ Favoritos** — save any trip or flight with the star. Each saved card
  shows today's price, the range seen so far, and how much it has moved since
  you saved it. Stored in SQLite, so they survive restarts.
- Click any row for the price history of that flight (both legs charted for a
  round trip).
- **Preguntar a la IA** — a chat panel (Gemini by default) that receives the
  current snapshot as context — routes, best legs, best round trips, Luxair
  fares, scoring weights — so it answers with your real fares and dates. It
  replies in a fixed structure (verdict → options → why) and tags each option
  it recommends with a marker the UI turns into a card you can save straight
  into favourites.

Round-trip filtering happens server-side (`/api/trips`): there are tens of
thousands of pairings, and a global top-N would hide every LUX trip behind
cheaper Ryanair ones.

## Configuration

Everything lives in [config.yaml](config.yaml): routes, how many months ahead to
look, the Google sampling window (`google.weeks` / `google.weekdays`), and the
scoring weights — what a work-hours departure "costs" you in euros, the bonus
for Friday evening and weekends, the early-morning penalty.

## Automating the daily snapshot

Windows Task Scheduler, daily at 09:00:

```
schtasks /Create /TN "FlightTracker" /SC DAILY /ST 09:00 /TR "python -m flighttracker fetch --google" /RU %USERNAME%
```

(Set the task's "Start in" directory to this folder, or wrap the command in a
small .bat that does `cd /d C:\Dev\personal\viajes` first.)

## Layout

```
flighttracker/
  __main__.py          CLI: fetch / report / history
  web.py               Flask app: dashboard + /api/{flights,trips,history,chat}
  chat.py              AI assistant — snapshot context + streaming (Gemini/Claude)
  static/index.html    dashboard shell
  static/info.html     /info - how the whole thing works, technically
  static/app.css       design tokens, app shell, every component
  static/shell.js      theme switching + collapsible sidebar (both pages)
  static/app.js        dashboard logic (filters, pagination, charts, chat)
  config.py            config.yaml loader
  db.py                SQLite schema, migrations and queries
                       (fares, package_fares, favorites)
  scoring.py           price -> effective cost adjustment
  providers/
    ryanair.py         Ryanair cheapest-per-day API
    google.py          Google Flights via fast-flights
    luxair.py          Luxair price calendar (whole round trips, no times)
config.yaml            routes, sampling window, scoring weights
.env                   API key for the chat assistant (gitignored)
prices.db              price history (created on first fetch)
```
