# Deployment

Deployed on the personal OVH VPS (`51.195.223.171`) via Coolify, alongside
senadoc and n8n. The infrastructure itself is documented in the
[`coolify-infra`](https://github.com/jose99segura/coolify-infra) repo.

Two containers share one database:

| Service | What it is |
|---|---|
| `app` | the Next.js dashboard — queries, scoring, pairing, UI |
| `fetcher` | the Python `flighttracker` package — the three providers, on a schedule |

The split exists because `providers/google.py` depends on `fast-flights`,
which speaks Google's own protobuf protocol. There is no TypeScript
equivalent, and it is the only source of Google data for LUX.

Health check: `curl https://<domain>/api/health` should return
`{"status":"ok"}`. It returns 503 when the app cannot reach the database,
which is the honest answer — the proxy then stops routing real traffic to a
container that cannot serve.

## What has to exist on the server first

Not yet provisioned. Unlike senadoc, this app needs **no Garage bucket and
no S3 key** — there are no uploads.

| Resource | Detail |
|---|---|
| Database | `viajes_prod` in the shared `postgres-shared` instance |
| Database role | `viajes_prod`, owner of that database only |
| DNS | an explicit A record → `51.195.223.171` |

No extensions are needed. The schema is ordinary tables and btree indexes.

### Isolation is enforced, not assumed

The app connects as `viajes_prod`, never as the `postgres` superuser.

**Postgres does not give you this by default**: `PUBLIC` has `CONNECT` on
every database, so any app role can open a connection to any other app's
database. Revoke it explicitly, as senadoc did:

```sql
REVOKE CONNECT ON DATABASE viajes_prod FROM PUBLIC;
GRANT  CONNECT ON DATABASE viajes_prod TO viajes_prod;
```

Then verify the negative case, not just the positive one: `viajes_prod`
connecting to `senadoc_prod` must be refused. Skipping this makes the
isolation cosmetic.

## Coolify configuration that is not obvious

All three of these have already cost a debugging session on senadoc.

### The compose file must be set explicitly

Coolify defaults the compose path to `/docker-compose.yaml`. **That is the
local development file**, which brings its own Postgres. Deploying it would
silently start a second, empty database and ignore `postgres-shared`
entirely — the app would run, report healthy and write nowhere useful.

Set **Docker compose location** to `/docker-compose.coolify.yml`.

### Projects are network-isolated

Coolify puts each project on its own Docker network. `postgres-shared` lives
on the `coolify` network, so a new app lands somewhere else and the
container name in `DATABASE_URL` does not resolve.

The symptom is misleading: the container starts, the logs show a clean
Next.js boot with no errors, and only the healthcheck fails — silently,
because the health route catches the connection error and returns 503
without logging it.

Fix: **Advanced → Container → Predefined network → "Connect to predefined
network"**, then redeploy. Verify:

```bash
sudo docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} ({{$v.IPAddress}}){{"\n"}}{{end}}' <container>
# the app must appear on `coolify`, alongside postgres-shared
```

### The www domain is added automatically and will break TLS

Adding a domain makes Coolify also create the `www.` variant, which has no
DNS record. Let's Encrypt would fail to validate it. DNS records here are
explicit (no wildcard), so delete the www entry unless you also create its
record.

## Environment variables

Set in Coolify, never in the compose file. `docker-compose.coolify.yml`
declares `DATABASE_URL` as `${DATABASE_URL:?...}` so a missing value fails
the container loudly at start instead of booting into a broken state.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://viajes_prod:<pw>@<postgres-shared container>:5432/viajes_prod` |
| `GEMINI_API_KEY` | no | chat panel only |
| `GEMINI_MODEL` | no | defaults to `gemini-3.7-flash` |
| `ANTHROPIC_API_KEY` | no | alternative to Gemini; Gemini wins if both are set |

The three optional ones are declared `${VAR:-}`, not `${VAR:?}`, on purpose:
the app works with no API key, exactly as it does today, and a `?err` would
turn an optional feature into a boot failure.

There is **no encryption key and no auth secret**. This app stores flight
prices, not personal data, and has no login. If it ends up publicly
reachable, put it behind Coolify's basic-auth or a Traefik middleware rather
than building one.

## Migrations

Migrations are **not** run by the container on start. Running them
automatically on every boot means a crash-looping container can re-run a
half-applied migration, and a rollback silently migrates the database
forward again.

Run them deliberately over an SSH tunnel, because `postgres-shared` has no
public port:

```bash
# re-check the container IP after a redeploy:
#   sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' <postgres-shared container>
ssh -f -N -i ~/.ssh/coolify_vps -L 55434:10.0.1.7:5432 ubuntu@51.195.223.171

DATABASE_URL="postgresql://viajes_prod:<password>@127.0.0.1:55434/viajes_prod" \
  pnpm db:migrate

# then close it
ps -ef | grep "55434" | grep -v grep | awk '{print $2}' | xargs kill
```

Port 55434 rather than senadoc's 55433, so both tunnels can be open at once.

Applying the SQL files directly with `psql` would work but would leave
Drizzle's `__drizzle_migrations` table unaware, so the next `db:migrate`
would try to re-apply them.

A hand-written migration must be added to `drizzle/meta/_journal.json` by
hand, or `db:migrate` skips it silently.

## Importing the existing price history

Do this **once**, after the first migration and before the first scheduled
fetch. `fares` is append-only and a snapshot of a past date can never be
re-collected, so this is the only chance to carry the history over.

Through the same tunnel:

```bash
DATABASE_URL="postgresql://viajes_prod:<password>@127.0.0.1:55434/viajes_prod" \
  python scripts/import_sqlite.py --sqlite prices.db
```

It refuses to run against a non-empty database rather than double-import,
and it verifies row counts, price sums and every distinct departure wall
clock before reporting success. Expect:

```
fares 1711 · package_fares 246 · alerts 4 · alert_hits 23 · favorites 2
```

**Do not delete `prices.db` until those counts are confirmed in production.**

## Scheduling the daily snapshot

This replaces the Windows Task Scheduler entry the README used to describe.

The `fetcher` container idles (`sleep infinity`) and a **Coolify Scheduled
Task** runs the fetch inside it. A scheduled task is a `docker exec`, so
something has to be running for it to exec into. An idle Python container
costs a few MB and no CPU, and it keeps the schedule visible in Coolify's UI
rather than buried in a crontab inside the image.

| Field | Value |
|---|---|
| Container | `fetcher` |
| Command | `python -m flighttracker fetch --google` |
| Frequency | `0 9 * * *` |

`--google` matters: without it, LUX has no data at all — Ryanair does not
fly there.

Every run appends exactly one snapshot, which is what makes the history
charts work, and re-checks the alert rules.

Check a run afterwards:

```bash
sudo docker logs <fetcher container> --tail 50
```

## Build notes

Builds run **on the VPS**, competing for CPU with Postgres, Garage and n8n.
The app Dockerfile uses Next.js `output: "standalone"` and installs
dependencies in a separate cached stage; the image is around 280 MB.

`config.yaml` is copied into the app image explicitly. It is read at
runtime — it holds the scoring weights, the routes and the sampling window —
and the standalone tracer only follows imports, so it would not be copied
otherwise. Both the app and the fetcher read the same file, which is what
keeps the two scoring implementations from drifting apart.

The fetcher image is `python:3.12-slim` rather than alpine: several
dependencies ship manylinux wheels and no musl ones, so alpine would compile
them from source on a VPS that is already short of CPU.

If builds start interfering with the running services, the next step is
building in GitHub Actions and having Coolify pull a prebuilt image.
