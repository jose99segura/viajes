"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { favorites } from "@/db/schema";
import type { FavoriteInput } from "@/lib/favorites";
import { canonical } from "@/lib/wallclock";

/**
 * Favourites. The star on any row calls this; the identity is the column
 * tuple, exactly as favorite_key() in db.py defines it (see
 * src/lib/favorites.ts), so a trip saved from the Flask UI and one saved
 * here are the same favourite.
 */

/** Save if absent, remove if present. Returns the new state. */
export async function toggleFavorite(f: FavoriteInput): Promise<boolean> {
  const where = and(
    eq(favorites.kind, f.kind),
    eq(favorites.outOrigin, f.outOrigin),
    eq(favorites.outDestination, f.outDestination),
    eq(favorites.outDeparture, canonical(f.outDeparture)),
    // NULL-safe on the return columns: a one-way favourite has all three
    // NULL, and `= NULL` would never match.
    sql`${favorites.retOrigin} IS NOT DISTINCT FROM ${f.retOrigin ?? null}`,
    sql`${favorites.retDestination} IS NOT DISTINCT FROM ${f.retDestination ?? null}`,
    sql`${favorites.retDeparture} IS NOT DISTINCT FROM CAST(${
      f.retDeparture ? canonical(f.retDeparture) : null
    } AS timestamp)`,
  );

  const existing = await db.select({ id: favorites.id }).from(favorites).where(where);
  let on: boolean;
  if (existing.length) {
    await db.delete(favorites).where(where);
    on = false;
  } else {
    await db
      .insert(favorites)
      .values({
        createdAt: new Date(),
        kind: f.kind,
        outOrigin: f.outOrigin,
        outDestination: f.outDestination,
        outDeparture: canonical(f.outDeparture),
        retOrigin: f.retOrigin ?? null,
        retDestination: f.retDestination ?? null,
        retDeparture: f.retDeparture ? canonical(f.retDeparture) : null,
        priceAtSave:
          f.priceAtSave === null || f.priceAtSave === undefined
            ? null
            : f.priceAtSave.toFixed(2),
      })
      .onConflictDoNothing();
    on = true;
  }

  // Every page shows stars or the favourites count.
  revalidatePath("/", "layout");
  return on;
}
