import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Locally: copy .env.example to .env.local. " +
      "On the VPS: set it in Coolify's environment variables.",
  );
}
/**
 * Check the shape here rather than letting the driver do it. A malformed
 * value reaches `new URL()` deep inside drizzle and surfaces as a bare
 * `TypeError: Invalid URL` with a stack in a minified chunk — which is what
 * a whole deployment was once spent diagnosing, after Coolify substituted
 * the text of a `${VAR:?message}` as the value itself.
 */
if (!/^postgres(ql)?:\/\//.test(connectionString)) {
  throw new Error(
    `DATABASE_URL is not a Postgres connection string: ${JSON.stringify(
      connectionString.slice(0, 60),
    )}. Expected postgresql://user:password@host:5432/database`,
  );
}

/**
 * Next.js recreates modules on every hot reload in development, which would
 * open a new pool each time until Postgres refuses connections. Caching on
 * globalThis keeps a single pool across reloads.
 */
const globalForDb = globalThis as unknown as {
  sqlClient?: ReturnType<typeof postgres>;
};

const sqlClient =
  globalForDb.sqlClient ??
  postgres(connectionString, {
    // postgres-shared is shared with other apps: staying modest here leaves
    // connection slots for them. Raise only with a reason.
    max: 10,
    idle_timeout: 20,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.sqlClient = sqlClient;
}

export const db = drizzle(sqlClient, { schema });
export { schema };
