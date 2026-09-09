# viajes — flight price tracker

Tracks flight prices between the Luxembourg-area airports (LUX / SCN / HHN) and
Alicante (ALC), keeps the full price history in Postgres, and ranks **round
trips** by *effective cost* rather than by ticket price. A cheap flight that
costs you a day off is not cheap, and neither is one that costs two hours of
driving each way.

It is a Next.js 16 app (App Router, React 19, TypeScript, Tailwind 4, Drizzle
over PostgreSQL 18) plus a Python fetcher — the original `flighttracker`
package — run on a schedule against the same database. Both containers are
deployed on a personal OVH VPS through Coolify; see
[docs/deployment.md](docs/deployment.md). There is no login and no object
storage: it is a single-user personal tool holding flight prices.

## Effective cost

Everything the UI ranks is scored the same way:

```
effective = ticket + convenience adjustment + ground + holiday
```

**Convenience** turns the departure time into euros: a weekend departure earns
−15, a Friday one after 17:30 earns −25, a departure inside working hours costs
+60, departing Mon-Thu at all costs +20, before 06:30 costs +15, and landing
back near Luxembourg after 22:30 costs +25 (only at the home end — a midnight
landing in Alicante is free).

**Ground** is what using that airport costs: driving there and back at €0.22/km
plus €12 an hour of your time, and parking for every day the car waits
(`nights + 1`). Per-airport distances, drive times and parking rates live in
`config.yaml` under `travel`. This is the **Coche** column, and it is what stops
a 25 € Ryanair fare from Hahn — 3h30 of driving away — from automatically
beating a 116 € Luxair fare from an airport 15 minutes from home. Return to a
*different* airport than you left from and both airports' driving is charged,
because the car is still where you parked it; an airport missing from
`travel.airports` simply costs nothing on the ground, so adding a route before
you have measured the drive degrades gracefully instead of breaking.

**Holiday** is €45 for every Mon-Fri day the trip eats *beyond the departure
day*. The departure day is deliberately excluded: the work-hours and weekday
penalties already price it, and charging both would bill the same day twice.

Those numbers are the current contents of [config.yaml](config.yaml), which is
the source of truth — read them there rather than trusting this paragraph.
Both the app (`src/lib/scoring.ts`) and the fetcher (`flighttracker/scoring.py`)
parse that same file, which is what keeps the two implementations from drifting.

### Días libres

The filter the whole model exists for. `workDaysUsed` counts the Mon-Fri days a
trip would actually cost: the departure day only if you leave before 17:30,
every weekday in between, and the return day whenever it is a weekday — even an
early flight home lands during working hours. So a Friday 22:00 → Sunday trip
costs **zero** days off, while Friday 09:35 → Monday costs two. Filter by it in
the trips view, or bake it into an alert.

Round-trip pairing and filtering happen **server-side**: there are tens of
thousands of pairings, and a global top-N would hide every LUX trip behind
cheaper Ryanair ones.

## Data sources

- **Ryanair fare-finder API** (`providers/ryanair.py`) — the public API behind
  the ryanair.com fare map. Cheapest fare per day, exact departure times, months
  ahead, fast and reliable. Covers HHN⇄ALC and SCN⇄ALC, always non-stop.
- **Google Flights** via [`fast-flights`](https://pypi.org/project/fast-flights/)
  (`providers/google.py`) — speaks Google's own protobuf protocol, no browser
  scraping. The only source for LUX, where Ryanair does not fly. Slow enough
  that it only samples the weekdays configured in `google.weekdays`. Includes an
  EU cookie-consent workaround and records the number of stops.
- **Luxair** (`providers/luxair.py`) — the price-calendar API behind luxair.lu,
  and the only source of **non-stop LUX–ALC**: Ryanair does not fly it and
  Google shows only 1–2 stop itineraries at 110 €+. Luxair operates it
  year-round as a LuxairTours route (typically Wed + Sat, plus Mon in peak
  summer).

  Two quirks, both handled. It quotes a **round trip as one price** for a
  departure date plus a trip length, so those fares live in their own
  `package_fares` table instead of being paired leg by leg. And it publishes
  **no departure times** — the Amadeus availability API that has them sits
  behind Imperva bot protection, so they are not obtainable headlessly. Since
  the route flies at most once a day the date is still actionable: the UI shows
  "sin hora" rather than inventing one, and these fares are scored on day of
  week only, never penalised for a work-hours departure that cannot be seen.

## The dashboard

A sidebar app in Spanish: the nav collapses to icons, and the theme can be set
to light, dark or system. Both choices persist in `localStorage` and are applied
by an inline script in `src/app/layout.tsx` before first paint, so there is no
flash on reload. `/info` documents sources, scoring, the data model and the
known limits.

- **Ida y vuelta** (`/`) — pairs every outbound leg with every return leg,
  scores the pair and ranks by combined effective cost. Luxair's whole-trip
  fares are mixed in, tagged `paq.`. Filter by airport, nights, when you would
  depart, price, same-airport-only, non-stop-only and días libres. The **Tipo**
  field switches the same page to **solo ida** — the raw fare list, same
  scoring — because one-way is a way of searching, not a separate place to go.
- **Calendario** (`/calendario`) — two months at a time, each day coloured by
  its best effective cost on a log scale, since fares cluster low with a long
  expensive tail. Switch between outbound and return; click a day to jump to the
  trips leaving then.
- **Alertas** (`/alertas`) — saved rules ("weekend, non-stop, under 120 €, no
  days off"). Every fetch re-checks them and flags what is new; the sidebar
  shows an unread count and the CLI prints the new matches.
- **Favoritos** (`/favoritos`) — save any trip or flight with the star. Each
  saved card shows today's price, the range seen so far, and how much it has
  moved since you saved it.
- Click any row for the price history of that flight, both legs charted for a
  round trip.
- **Preguntar a la IA** — a chat panel that receives the current snapshot as
  context (routes, best legs, best round trips, Luxair fares, scoring weights)
  so it answers with your real fares and dates. It replies in a fixed structure
  (verdict → options → why) and tags each option it recommends with a marker the
  UI turns into a card you can save straight into favourites. Gemini by default,
  Claude if only `ANTHROPIC_API_KEY` is set; with no key at all the panel is
  simply unavailable and the rest of the app is unaffected.

## Development

```bash
docker compose up -d    # Postgres 18 on host port 5546
pnpm install
cp .env.example .env.local
pnpm db:migrate
pnpm dev                # http://localhost:3011
```

`docker-compose.yml` runs the same `pgvector/pgvector:pg18` image as production,
so local behaviour is production behaviour. The only variable that has to be set
is `DATABASE_URL`; `GEMINI_API_KEY` / `GEMINI_MODEL` / `ANTHROPIC_API_KEY` are
optional and only the chat panel notices their absence.

```bash
pnpm db:generate        # after changing src/db/schema.ts
pnpm db:migrate
pnpm db:studio
pnpm test               # includes the Python/TypeScript equivalence test
pnpm verify:timestamps  # departures survive the round trip in any time zone
```

The Python side is separate:

```bash
pip install -r requirements.txt
python -m flighttracker fetch                 # Ryanair + Luxair (fast)
python -m flighttracker fetch --google        # + Google Flights (needed for LUX)
python -m flighttracker report                # best flights by effective cost
python -m flighttracker report --route HHN-ALC --max-price 60
python -m flighttracker history HHN-ALC 2026-10-25   # price evolution for a day
python -m flighttracker alerts                # current matches per alert rule
python -m flighttracker models                # Gemini models your key can use
```

Every `fetch` run appends exactly one snapshot, which is what makes the history
charts work — that is how you learn when to buy — and re-checks the alert rules.

## Automating the daily snapshot

In production the `fetcher` container idles and a **Coolify Scheduled Task**
runs `python -m flighttracker fetch --google` inside it, daily at 09:00. A
scheduled task is a `docker exec`, so something has to be running for it to exec
into; an idle Python container costs a few MB and keeps the schedule visible in
Coolify's UI rather than buried in a crontab inside the image. `--google`
matters: without it LUX has no data at all.

The full setup — database and role, the Coolify settings that are not obvious,
running migrations over an SSH tunnel, importing the existing price history — is
in [docs/deployment.md](docs/deployment.md).

## Configuration

[config.yaml](config.yaml) holds the routes, how many months ahead to look, the
Google sampling window (`google.weeks` / `google.weekdays`), the Luxair trip
lengths to query, the ground costs (`travel`) and the scoring weights. It is
read at runtime by both halves, and it is copied into the app image explicitly
by the Dockerfile — the standalone tracer only follows imports, so without that
COPY every fare would score with default weights.

## Layout

```
src/
  app/                 App Router: / (Ida y vuelta), /calendario, /alertas,
                       /favoritos, /info, /api/{health,history,favorites,chat}
  components/          shell (sidebar, theme), trips, calendar, alerts,
                       favorites, flights, chat
  db/
    schema.ts          Drizzle schema — fares, package_fares, alerts,
                       alert_hits, favorites
    queries.ts         the snapshot queries the pages run
  lib/
    config.ts          config.yaml, parsed
    scoring.ts         convenience adjustment, ground cost, holiday cost
    trips.ts           round-trip pairing and ranking
    wallclock.ts       zone-free date arithmetic on departure timestamps
    alerts.ts, calendar.ts, favorites.ts, booking.ts, format.ts, url.ts
    chat/              provider, prompt, snapshot context, markdown
flighttracker/         the Python fetcher
  __main__.py          CLI: fetch / report / history / alerts / models
  providers/           ryanair.py, google.py, luxair.py
  db.py                Postgres storage (pg8000)
  scoring.py, trips.py the fetcher's copy of the scoring model
  alerts.py            alert rules and new-match tracking
drizzle/               generated migrations + meta/_journal.json
scripts/
  import_sqlite.py     one-off import of the old prices.db
  score_fixture.py     Python side of the equivalence test
  verify-timestamps.ts proves departures are zone-independent
tests/
  equivalence.test.ts  same fixture through both languages, identical output
config.yaml            routes, sampling window, scoring weights, ground costs
Dockerfile             the Next.js app (standalone)
Dockerfile.fetcher     the Python fetcher
docker-compose.yml     local Postgres
docker-compose.coolify.yml   production, on the shared Postgres
```
