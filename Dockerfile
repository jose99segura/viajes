# Multi-stage build for Next.js standalone output.
#
# Builds run ON THE VPS, competing for CPU with Postgres, Garage and n8n.
# Every stage here exists to keep that cost down: dependencies are installed
# once and cached, and the final image carries only the standalone server.

FROM node:22-alpine AS base
# Next.js binaries expect glibc-compatible symbols that Alpine's musl lacks.
RUN apk add --no-cache libc6-compat
RUN corepack enable

# pnpm asks for interactive confirmation before purging a node_modules it
# considers stale, which cannot be answered in a build and fails the whole
# thing with a stack trace rather than a clear message. CI=true makes it
# non-interactive.
ENV CI=true

# ---------------------------------------------------------------------------
# Dependencies — cached unless the lockfile changes
# ---------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# `next build` imports the app's modules, and src/db/index.ts throws when
# DATABASE_URL is missing. This placeholder exists only so the import
# succeeds; the real value is injected at runtime by Coolify.
#
# Passed inline rather than via ENV deliberately: an ENV is written into the
# image layer and would ship a (dummy) connection string inside every image,
# which also trips Docker's SecretsUsedInArgOrEnv check. Inline, it exists
# only for the duration of this RUN.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    pnpm build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Never run the server as root: a code-execution bug should not also grant
# the container's filesystem.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# `public` is empty today. It is kept in git by public/.gitkeep, and that
# file is load-bearing: git does not version empty directories, so without
# it the directory is absent from the build context and this COPY fails with
# "/app/public: not found" — on the VPS only, since a local build has the
# untracked directory sitting there. Do not delete it to tidy up.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# config.yaml is read at RUNTIME, not bundled: it holds the scoring weights,
# the routes and the sampling window, and both the app and the Python fetcher
# read the same file so the two scoring implementations cannot drift. The
# standalone tracer only follows imports, so it would not copy this by itself
# — and without it every fare would score with default weights.
COPY --from=builder --chown=nextjs:nodejs /app/config.yaml ./config.yaml

# Migrations and the drizzle config are needed at deploy time, not at build
# time. They are run deliberately from a workstation over an SSH tunnel (see
# docs/deployment.md); these copies exist so the image can also do it.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/src/db ./src/db

USER nextjs
EXPOSE 3000

# Reports unhealthy while the app cannot serve, so Coolify's proxy stops
# routing to a broken container instead of returning 502s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
