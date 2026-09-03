/**
 * Proves that a departure wall clock survives the round trip through Drizzle
 * unchanged, and that it does not depend on the process time zone.
 *
 * senadoc has scripts/verify-encryption.ts for the same reason: unit-testing
 * the helper in isolation would pass even if the column were the wrong type.
 * Here the failure mode is quieter than a wrong type -- everything works, and
 * a departure is just an hour off, which moves it across the 17:30 boundary
 * and changes what the "dias libres" filter returns.
 *
 * Run it after touching src/db/schema.ts:
 *
 *     pnpm tsx scripts/verify-timestamps.ts
 *
 * It writes through the real table inside a transaction and rolls back, so it
 * is safe against the live database and still exercises the real column
 * types. It goes through db.select() rather than db.execute(): raw SQL skips
 * Drizzle's type mapping, which is the thing under test.
 *
 * It also re-runs itself in a deliberately hostile time zone. Running only in
 * the machine's own zone is what lets this class of bug through.
 */

import { spawnSync } from "node:child_process";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import { fares } from "../src/db/schema";

/** A summer date, so any zone observing DST is offset from UTC. */
const WALL_CLOCK = "2026-07-15 17:20:00";
const CAPTURED_AT = new Date("2026-07-01T11:22:30.000Z");
const PROBE_SOURCE = "__verify_timestamps__";

class Done extends Error {}

async function main() {
  const zone = process.env.TZ ?? "(machine default)";
  const failures: string[] = [];
  let row: typeof fares.$inferSelect | undefined;

  try {
    await db.transaction(async (tx) => {
      await tx.insert(fares).values({
        capturedAt: CAPTURED_AT,
        source: PROBE_SOURCE,
        origin: "LUX",
        destination: "ALC",
        departure: WALL_CLOCK,
        arrival: WALL_CLOCK,
        airline: "Probe",
        stops: 0,
        price: "99.99",
        currency: "EUR",
        soldOut: false,
      });
      [row] = await tx
        .select()
        .from(fares)
        .where(and(eq(fares.source, PROBE_SOURCE), eq(fares.origin, "LUX")));
      // Never leave the probe behind: this runs against the real history.
      throw new Done();
    });
  } catch (error) {
    if (!(error instanceof Done)) throw error;
  }

  if (!row) throw new Error("the probe row was not read back");

  if (typeof row.departure !== "string") {
    failures.push(
      `departure came back as ${typeof row.departure}, not a string. ` +
        `mode: "string" is what keeps the wall clock out of a Date.`,
    );
  } else if (row.departure !== WALL_CLOCK) {
    failures.push(`departure: wrote ${WALL_CLOCK}, read ${row.departure}`);
  }

  if (!(row.capturedAt instanceof Date)) {
    failures.push(`capturedAt came back as ${typeof row.capturedAt}, not a Date`);
  } else if (row.capturedAt.getTime() !== CAPTURED_AT.getTime()) {
    failures.push(
      `capturedAt: wrote ${CAPTURED_AT.toISOString()}, ` +
        `read ${row.capturedAt.toISOString()}`,
    );
  }

  console.log(`TZ=${zone}`);
  console.log(`  departure   ${WALL_CLOCK} -> ${String(row.departure)}`);
  console.log(
    `  capturedAt  ${CAPTURED_AT.toISOString()} -> ` +
      `${row.capturedAt instanceof Date ? row.capturedAt.toISOString() : String(row.capturedAt)}`,
  );

  // The column types themselves, in case a future migration quietly turns one
  // into a timestamptz.
  const columns = (await db.execute(sql`
    select column_name, data_type from information_schema.columns
     where table_name = 'fares'
       and column_name in ('departure', 'arrival', 'captured_at')
     order by column_name
  `)) as unknown as Array<{ column_name: string; data_type: string }>;

  const expected: Record<string, string> = {
    arrival: "timestamp without time zone",
    captured_at: "timestamp with time zone",
    departure: "timestamp without time zone",
  };
  for (const { column_name, data_type } of columns) {
    if (data_type !== expected[column_name]) {
      failures.push(
        `fares.${column_name} is ${data_type}, expected ${expected[column_name]}`,
      );
    }
    console.log(`  fares.${column_name}: ${data_type}`);
  }

  // Nothing of the probe may survive the rollback.
  const [{ leftovers }] = (await db.execute(sql`
    select count(*)::int as leftovers from fares where source = ${PROBE_SOURCE}
  `)) as unknown as Array<{ leftovers: number }>;
  if (leftovers !== 0) {
    failures.push(`${leftovers} probe rows survived the rollback`);
  }

  if (failures.length) {
    console.error("\nFAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }

  // Re-run once under a zone far from both UTC and Europe/Madrid. If the wall
  // clock is genuinely zone-independent, the second pass is identical.
  if (process.env.VERIFY_TZ_CHILD) return;

  console.log("");
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", ...process.argv.slice(1)],
    {
      stdio: "inherit",
      env: { ...process.env, TZ: "Pacific/Kiritimati", VERIFY_TZ_CHILD: "1" },
    },
  );
  if (child.status !== 0) {
    console.error(
      "\nFAILED: the same data reads differently under TZ=Pacific/Kiritimati.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nWall clocks are zone-independent. OK.");
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
