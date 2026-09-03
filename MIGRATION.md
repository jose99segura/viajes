# Migration brief — from Flask/SQLite to the senadoc stack, deployable on Coolify

This document is the task specification for rewriting `viajes` (today a Python
Flask app with a SQLite file and a static-HTML dashboard) as a Next.js
application on the same stack as the sibling project `C:\Dev\personal\senadoc`,
built to deploy on the personal OVH VPS through Coolify.

Read `README.md` first: it explains what the tracker does, the three data
sources, the scoring model and the current UI. Nothing in the product changes.
Only how it is built and shipped.

## Target stack (mirror senadoc)

| Piece | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Database | PostgreSQL 18 (`pgvector/pgvector:pg18`) — the same image senadoc uses |
| ORM | Drizzle (`drizzle-orm` + `drizzle-kit`, `postgres` driver) |
| Styling | Tailwind 4 (`@tailwindcss/postcss`) |
| Package manager | pnpm |
| Runtime image | `node:22-alpine`, Next.js `output: "standalone"` |
| Deploy | Coolify on the VPS, via `docker-compose.coolify.yml` |

Auth and object storage are **not** needed here: this is a single-user personal
tool with no uploads and no personal data. Do not pull in BetterAuth or S3.
If the deployment ends up publicly reachable, put it behind Coolify's basic-auth
or a Traefik middleware rather than building a login.

## What to keep in Python, and why

The three providers are the risky part of a rewrite:

- `providers/ryanair.py` and `providers/luxair.py` are plain JSON HTTP calls,
  ~170 lines together. These port to TypeScript cleanly.
- `providers/google.py` depends on `fast-flights`, which speaks Google's own
  **protobuf** protocol. There is no TypeScript equivalent, and it is the only
  source of Google data for LUX. Rewriting it means reimplementing that
  encoding — out of scope and easy to get subtly wrong.

**Decision: keep the fetcher as Python.** Ship two containers sharing one
Postgres database:

1. `app` — the Next.js dashboard (read-mostly: queries, scoring, pairing, UI).
2. `fetcher` — the existing `flighttracker` package, reduced to `fetch` +
   `alerts`, writing into Postgres instead of SQLite, run on a schedule.

This keeps every provider quirk already solved (the EU cookie-consent
workaround, Luxair's whole-trip fares, the Amadeus/Imperva dead end) exactly as
it is. Port `db.py` from `sqlite3` to `psycopg`; leave the providers untouched.

Scoring and round-trip pairing move to TypeScript in the app (`scoring.py` →
`src/lib/scoring.ts`, `trips.py` → `src/lib/trips.ts`) because the API needs
them per request. `alerts.py` needs the same logic on the fetcher side — keep
the Python copy for the fetch-time alert check, and have both read the weights
from `config.yaml` so they cannot drift. Add a test that scores the same fixture
in both languages and asserts identical output: two implementations of one
formula is the one real risk this split introduces.

## Database

Port the SQLite schema in `flighttracker/db.py` to Drizzle in
`src/db/schema.ts`, with proper Postgres types:

- `fares` — `captured_at` / `departure` / `arrival` become `timestamptz` (they
  are ISO text today), `price` becomes `numeric(10,2)`, `sold_out` becomes
  `boolean`. Keep the indexes on `(origin, destination, departure)` and
  `(captured_at)`.
- `package_fares` — Luxair's whole-round-trip fares, `out_date` as `date`.
- `alerts`, `alert_hits`, `favorites` — as they are; keep the `favorites`
  uniqueness constraint and `alert_hits`'s composite primary key.

`fares` is append-only by design — one snapshot per fetch is what makes the
history charts work. Do not add an upsert that overwrites yesterday's row.

Write a one-off `scripts/import-sqlite.ts` (or a Python equivalent) that copies
the existing `prices.db` into Postgres, so the history collected so far is not
lost. Verify row counts match before deleting anything.

Follow senadoc's migration rules: `pnpm db:generate` after changing
`schema.ts`, and hand-written SQL must be added manually to
`drizzle/meta/_journal.json` or `db:migrate` silently skips it.

## Application shape

Mirror senadoc's layout: `src/app` (App Router), `src/components`, `src/db`,
`src/lib`. Server Components for pages, Server Actions for mutations
(favourites, alert CRUD), route handlers only where a real API is needed.

Pages, keeping the current Spanish nav (see `static/index.html`, `static/app.js`):

- `/` — **Ida y vuelta**: paired round trips ranked by effective cost, with the
  existing filters (airport, nights, departure window, price, same-airport-only,
  non-stop-only, días libres). Pairing and filtering stay **server-side**: there
  are tens of thousands of pairings and a global top-N hides every LUX trip
  behind cheaper Ryanair ones.
- `/solo-ida` — the raw fare list, same scoring.
- `/calendario` — two months at a time, each day coloured by its cheapest fare
  on a log scale; toggle outbound/return; clicking a day filters the trips view.
- `/alertas` — saved rules, with the unread count in the sidebar.
- `/favoritos` — saved trips showing today's price, the range seen so far, and
  the movement since saving.
- `/info` — port `static/info.html` as-is; it documents sources, scoring, the
  data model and the known limits.
- Price-history charts on row click, both legs for a round trip.

Port `static/app.css` (728 lines of design tokens and components) to Tailwind 4,
keeping the same visual result: collapsible icon sidebar, light/dark/system
theme persisted in `localStorage` and applied before first paint so there is no
flash. In the App Router that means an inline script in `src/app/layout.tsx`.

The AI chat panel (`chat.py`, Gemini over REST with streaming) becomes a route
handler streaming to the client. Keep the snapshot-as-context design and the
option-marker convention the UI turns into savable cards. Keep it optional: the
app must work with no API key, exactly as it does today.

## Deployment

Copy senadoc's files and adapt:

- `Dockerfile` — multi-stage `deps` → `builder` → `runner`, standalone output,
  non-root `nextjs` user, `HEALTHCHECK` against `/api/health`. The same
  reasoning applies: builds run on the VPS and compete with Postgres, Garage and
  n8n, so keep the layers cached and the final image small. If a module throws
  when `DATABASE_URL` is missing, pass a placeholder **inline** to `pnpm build`,
  never as `ENV` (it would be baked into the image layer).
- `Dockerfile.fetcher` — a small `python:3.12-slim` image for the fetcher.
- `docker-compose.yml` — local dev: `pgvector/pgvector:pg18` on 5432, matching
  production so local behaviour is production behaviour.
- `docker-compose.coolify.yml` — production. **Never declare a `networks:`
  block**: Coolify attaches the container to the `coolify` network, and a second
  one makes Traefik pick non-deterministically, ending in permanent 504s after
  some container recreations. No host port bindings, `expose: 3000`, a
  `mem_limit` (the host has 8 GB and is shared — 512m is plenty here), json-file
  logging capped at 10m×3, and every secret from Coolify's environment written
  as `${VAR:?message}` so a missing one fails loudly at start.
- `next.config.ts` — `output: "standalone"`. senadoc's clinical headers are not
  needed, but `X-Content-Type-Options` and `X-Frame-Options` cost nothing.
- `/api/health` — a route handler that checks the database and returns 200.
- `.env.example` documenting `DATABASE_URL`, `GEMINI_API_KEY` (optional),
  `GEMINI_MODEL`, `ANTHROPIC_API_KEY` (optional).

Scheduling the daily snapshot: replace the Windows Task Scheduler section of the
README with a scheduled run of the fetcher container — simplest is a Coolify
Scheduled Task running `python -m flighttracker fetch --google`. Document
whichever mechanism you pick in `docs/deployment.md`.

## Configuration

`config.yaml` stays the source of truth for routes, `months_ahead`, the Google
sampling window and the scoring weights. The fetcher already reads it; the
TypeScript side should parse the same file (or a `config.json` generated from
it) rather than duplicating the numbers in code.

## Order of work

1. Scaffold Next.js 16 + TS + Tailwind 4 + Drizzle; `docker compose up -d`.
2. `schema.ts` and the first migration; import `prices.db`; verify row counts.
3. Port the fetcher's storage layer to Postgres; confirm a real `fetch` writes.
4. `scoring.ts` and `trips.ts`, with the cross-language equivalence test.
5. Queries and API, then the pages, then the CSS port.
6. Chat.
7. Dockerfiles, compose files, health check, `docs/deployment.md`.
8. Rewrite `README.md` for the new stack; delete what no longer applies.

Do not delete `prices.db`, the Python providers or `config.yaml` until the
replacement is verified working end to end.

## Ground rules

- Code, comments, commit messages and docs in **English**; user-facing strings
  in **Spanish** (the UI already is — keep it).
- Add a `CLAUDE.md` in the style of senadoc's: not a feature list, but the
  handful of decisions a future session would otherwise get wrong — the
  Python/TypeScript split, append-only `fares`, no `networks:` block in the
  Coolify compose, migrations needing a `_journal.json` entry, and Luxair fares
  having no departure time and therefore never being penalised for one.
