import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Liveness probe for the container healthcheck and Coolify's proxy.
 *
 * It checks the database too: a container that is up but cannot reach
 * Postgres serves nothing useful, and reporting it healthy would leave the
 * proxy sending real traffic to it.
 *
 * Deliberately leaks nothing — no version, no hostname, no error detail.
 * The whole app is unauthenticated, but this endpoint is also the one thing
 * a misconfigured proxy is most likely to expose.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok" }, { status: 200 });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
