# viajes

Flight price tracker for the Luxembourg-area airports (LUX / SCN / HHN) to
Alicante. Ranks round trips by *effective cost* — ticket plus the convenience
of the departure time, plus driving to the airport, plus the holiday the trip
eats — and keeps every snapshot so the price history is chartable.

Personal project (not ControlC work). GitHub account `jose99segura`, deployed on
the personal OVH VPS via Coolify, alongside senadoc. Single user, no login, no
personal data, no object storage — do not add BetterAuth or S3 here.

## Language

- Code, comments, identifiers, commit messages and docs: **English**.
- User-facing strings: **Spanish**. The nav names are fixed: Ida y vuelta,
  Calendario, Alertas, Favoritos.

## Architecture

| Piece | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Database | PostgreSQL 18 (`pgvector/pgvector:pg18`) |
| ORM | Drizzle (`postgres` driver) |
| Styling | Tailwind 4 |
| Package manager | pnpm |
| Fetcher | Python 3.12, the original `flighttracker` package |

```bash
docker compose up -d      # Postgres on host port 5546
pnpm dev                  # port 3011
pnpm db:generate          # after changing src/db/schema.ts
pnpm db:migrate
pnpm test
pnpm verify:timestamps
```

## The thing that shapes everything else

**The fetcher is Python and the app is TypeScript, and the scoring model exists
in both.** `providers/google.py` depends on `fast-flights`, which speaks
Google's own protobuf protocol; there is no TypeScript equivalent and it is the
only source of Google data for LUX. Rewriting it means reimplementing that
encoding, so the fetcher stays Python and the two halves share one Postgres.

The app needs the scoring model per request, and the fetcher needs it right
after each snapshot to evaluate the alert rules. So it lives twice:

| | app | fetcher |
|---|---|---|
| Scoring | `src/lib/scoring.ts` | `flighttracker/scoring.py` |
| Round-trip pairing | `src/lib/trips.ts` | `flighttracker/trips.py` |

Two implementations of one formula is the real risk of this split, and it is
held in check two ways. Neither side owns the weights — both parse
`config.yaml`, so a change reaches both or neither. And `tests/equivalence.test.ts`
runs the same fixture through the TypeScript side and compares it against what
the Python side produced (`tests/fixtures/expected.json`, written by
`scripts/score_fixture.py`), including a case that re-runs the Python scorer to
prove the committed oracle is not stale — otherwise editing `scoring.py` alone
would leave the tests green.

**Change one, change the other, then `pnpm test`.** The fixture deliberately
contains fares sitting exactly on the boundaries (09:00, 17:30, 06:30), which is
where a `<` against a `<=` would otherwise hide.

## Database rules

### `fares` is append-only

One snapshot per fetch run is what makes the history charts work: a fare's
movement over time is the whole point of collecting it daily. Never add an
upsert that overwrites yesterday's row. A snapshot of a past date can never be
re-collected.

### `departure` / `arrival` are `timestamp` WITHOUT time zone

`captured_at` is a real instant and is `timestamptz`. Departures are not: they
are the airline's local wall clock with no offset attached, which is exactly
what the providers return. Storing an offset would mean inventing one.

This is not a detail. Scoring reads the clock — a weekday departure before 17:30
costs a day off, after it does not. As `timestamptz` the hour would follow the
reader's session zone: the container runs UTC, the dev machine is
Europe/Madrid, and the same row would then score differently in each, so the app
and the Python alert check would disagree about `work_days_used`.

The columns are `mode: "string"` and **nothing on the TypeScript side builds a
`Date` from a departure**. `src/lib/wallclock.ts` works on the components
instead; the only Date API it touches is `Date.UTC`, which is a pure function of
its arguments. `scripts/verify-timestamps.ts` proves the round trip through
Drizzle is lossless and re-runs itself under `TZ=Pacific/Kiritimati`, because
running only in the machine's own zone is what lets this class of bug through.

### Trip keys must stay byte-identical across the two languages

`alert_hits.trip_key` is written by the Python fetcher and read by the app. It
is `origin|departure|destination|departure`, and Postgres renders a timestamp
with a space where the canonical form uses `T`. `canonical()` in
`wallclock.ts` exists for exactly this. Get it wrong and every alert match
already stored re-appears as new.

The same applies to iteration and tie-breaking in `buildTrips`: outbound-major
in snapshot order, packages appended, then a stable sort by effective cost.
Python does the same, so the top-N an alert records is the same top-N.

### Luxair fares have no departure time

They live in `package_fares` — a whole round trip quoted as one price for a
departure date plus a trip length — rather than in `fares`, which is per leg
with exact times. `out_date` is a `date`. They are scored on day of week alone
(`dayAdjustment`) and are **never** penalised for a work-hours departure that
cannot be seen; their days-off count is deliberately conservative instead. The
UI says "sin hora" rather than inventing 00:00.

### `favorites` uses `UNIQUE NULLS NOT DISTINCT`

A one-way favourite has all three `ret_*` columns NULL. SQLite treated NULLs as
distinct in a UNIQUE index, so the old constraint never actually deduplicated
them, while the delete path already compared them with `IFNULL(...,'')`, i.e. as
equal. `NULLS NOT DISTINCT` makes the constraint mean what the surrounding code
always assumed.

### pg8000, not psycopg

The Python side connects with pg8000: pure Python, no libpq. `psycopg-binary`
has no Windows ARM64 wheel and the dev machine is Windows ARM64, so psycopg
would make the fetcher container-only. Same constraint that keeps
`cryptography` — and therefore the `google-genai` SDK — out of the chat client,
which talks to the REST API directly. Placeholders stay `?` (pg8000 accepts
qmark paramstyle), which also means a literal `%` in SQL needs no escaping.

## Migrations

`drizzle-kit generate` produces `drizzle/NNNN_*.sql`. A hand-written migration
**must be added to `drizzle/meta/_journal.json` by hand** or `db:migrate` skips
it silently, and nothing tells you.

Nothing runs migrations on deploy: Coolify builds and restarts the container, it
does not migrate. Run them deliberately over an SSH tunnel — `docs/deployment.md`
has the exact commands.

### Production tables must be owned by the app role

`ALTER TABLE` requires **ownership**. No `GRANT` substitutes for it: `GRANT ...
ON ALL TABLES` and `ALTER DEFAULT PRIVILEGES` only cover tables that exist at
the time, and drizzle-kit exits 1 without printing anything useful. This cost a
debugging session on senadoc, where four tables created by the superuser broke a
migration and, earlier, were unreadable by the app.

Run migrations as `viajes_prod` so every table it creates is its own, and check
the negative case:

```sql
select tablename, tableowner from pg_tables
 where schemaname = 'public' and tableowner <> 'viajes_prod';
```

Zero rows, or both problems come back together.

## Deployment

Full details in `docs/deployment.md`; these two are the ones that fail silently.

### Never declare a `networks:` block in `docker-compose.coolify.yml`

Coolify attaches the containers to the `coolify` network, where Traefik lives. A
second network puts a container on two at once, Traefik then picks one
non-deterministically, and some container recreations end in permanent 504s.
Containers still reach each other by service name without it.

### "Connect to predefined network" must be ON

Coolify puts each project on its own Docker network, and `postgres-shared` is on
`coolify`. Without the toggle (Advanced → Container → Predefined network) the
hostname in `DATABASE_URL` does not resolve. The symptom is misleading: the
container starts, the logs show a clean Next.js boot with no errors, and only
the healthcheck fails — silently, because the health route catches the
connection error and returns 503 without logging it.

Related: the compose path must be set to `/docker-compose.coolify.yml`. Coolify
defaults to `/docker-compose.yaml`, which is the local development file and
would start a second, empty Postgres that the app happily writes nowhere useful.

### `config.yaml` is copied into the app image explicitly

The Dockerfile has a `COPY` for it because it is read at **runtime** and the
standalone tracer only follows imports. Without that line every fare would score
with default weights — quietly, since nothing crashes.

## Tests

```bash
pnpm test
```

`tests/equivalence.test.ts` is the one that matters; see the split above.
`tests/chat.test.ts` covers the option-marker parsing the UI turns into savable
cards. Neither needs a database. `pnpm verify:timestamps` does, and should be
run after touching `src/db/schema.ts`.
