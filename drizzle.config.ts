import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // `fares` is append-only price history that cannot be re-fetched for past
  // dates. Fail loudly rather than let drizzle-kit guess at a destructive
  // change.
  strict: true,
  verbose: true,
});
