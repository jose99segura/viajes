import { and, count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { alertHits, alerts, favorites } from "@/db/schema";
import type { FareRow, PackageRow } from "@/lib/trips";

/**
 * Read queries. Ports of the SELECTs in flighttracker/db.py.
 *
 * The snapshot queries are raw SQL for two reasons. They are join-on-max
 * queries that Drizzle's builder expresses less clearly than the SQL does,
 * and — the one that matters — they render every timestamp with to_char so
 * the rows arrive as the exact strings the Python side sees: departures in
 * canonical "T" form and captured_at as ISO with "+00:00". No Date is ever
 * constructed for a departure, which is the rule in src/lib/wallclock.ts.
 *
 * Prices come back as float8 rather than numeric-as-string; scoring does
 * arithmetic on them, and these are two-decimal fares, not money that
 * compounds.
 */

const WALL = `'YYYY-MM-DD"T"HH24:MI:SS'`;
const INSTANT = `'YYYY-MM-DD"T"HH24:MI:SS"+00:00"'`;

/** Most recent price seen for each (route, departure), future only. */
export async function latestSnapshot(): Promise<FareRow[]> {
  const rows = await db.execute(sql.raw(`
    SELECT f.origin, f.destination,
           to_char(f.departure, ${WALL}) AS departure,
           to_char(f.arrival, ${WALL}) AS arrival,
           f.airline, f.stops, f.price::float8 AS price, f.currency, f.source,
           to_char(f.captured_at AT TIME ZONE 'UTC', ${INSTANT}) AS captured_at
    FROM fares f
    JOIN (
      SELECT origin, destination, departure, max(captured_at) AS mc
      FROM fares GROUP BY origin, destination, departure
    ) last ON f.origin = last.origin
          AND f.destination = last.destination
          AND f.departure = last.departure
          AND f.captured_at = last.mc
    WHERE f.sold_out = false AND f.departure >= CURRENT_DATE
    ORDER BY f.departure
  `));
  return (rows as unknown as RawFare[]).map((r) => ({
    origin: r.origin,
    destination: r.destination,
    departure: r.departure,
    arrival: r.arrival,
    airline: r.airline,
    stops: r.stops,
    price: r.price,
    currency: r.currency,
    source: r.source,
    capturedAt: r.captured_at,
  }));
}

/** Most recent price for each (route, departure date, trip length). */
export async function latestPackages(): Promise<PackageRow[]> {
  const rows = await db.execute(sql.raw(`
    SELECT p.origin, p.destination,
           to_char(p.out_date, 'YYYY-MM-DD') AS out_date,
           p.nights, p.price::float8 AS price, p.currency, p.source,
           to_char(p.captured_at AT TIME ZONE 'UTC', ${INSTANT}) AS captured_at
    FROM package_fares p
    JOIN (
      SELECT origin, destination, out_date, nights, max(captured_at) AS mc
      FROM package_fares GROUP BY origin, destination, out_date, nights
    ) last ON p.origin = last.origin AND p.destination = last.destination
          AND p.out_date = last.out_date AND p.nights = last.nights
          AND p.captured_at = last.mc
    WHERE p.out_date >= CURRENT_DATE
    ORDER BY p.out_date
  `));
  return (rows as unknown as RawPackage[]).map((r) => ({
    origin: r.origin,
    destination: r.destination,
    outDate: r.out_date,
    nights: r.nights,
    price: r.price,
    currency: r.currency,
    source: r.source,
    capturedAt: r.captured_at,
  }));
}

export interface HistoryPoint {
  capturedAt: string;
  departure: string;
  airline: string | null;
  stops: number;
  price: number;
  source: string;
}

/** All captures for flights on a given YYYY-MM-DD, oldest first. */
export async function priceHistory(
  origin: string,
  destination: string,
  day: string,
): Promise<HistoryPoint[]> {
  const rows = await db.execute(sql`
    SELECT to_char(captured_at AT TIME ZONE 'UTC', ${sql.raw(INSTANT)}) AS captured_at,
           to_char(departure, ${sql.raw(WALL)}) AS departure,
           airline, stops, price::float8 AS price, source
    FROM fares
    WHERE origin = ${origin.toUpperCase()} AND destination = ${destination.toUpperCase()}
      AND departure >= CAST(${day} AS date)
      AND departure < CAST(${day} AS date) + INTERVAL '1 day'
    ORDER BY captured_at
  `);
  return (rows as unknown as RawHistory[]).map((r) => ({
    capturedAt: r.captured_at,
    departure: r.departure,
    airline: r.airline,
    stops: r.stops,
    price: r.price,
    source: r.source,
  }));
}

/**
 * Identity of every saved favourite, in the form favorite_key() in db.py
 * produces — the UI compares against it to draw a filled star.
 */
export async function favoriteKeys(): Promise<Set<string>> {
  const rows = await db.execute(sql.raw(`
    SELECT concat_ws('|', kind, out_origin, out_destination,
                     to_char(out_departure, ${WALL}),
                     coalesce(ret_origin, ''), coalesce(ret_destination, ''),
                     coalesce(to_char(ret_departure, ${WALL}), '')) AS key
    FROM favorites
  `));
  return new Set((rows as unknown as Array<{ key: string }>).map((r) => r.key));
}

/** Sidebar badges: saved favourites, and alert matches not yet looked at. */
export async function sidebarCounts(): Promise<{ favorites: number; unseen: number }> {
  const [[f], [u]] = await Promise.all([
    db.select({ n: count() }).from(favorites),
    db
      .select({ n: count() })
      .from(alertHits)
      .innerJoin(alerts, eq(alerts.id, alertHits.alertId))
      .where(and(eq(alertHits.seen, false), eq(alerts.enabled, true))),
  ]);
  return { favorites: f.n, unseen: u.n };
}

// ---------- one flight, for favourites ----------

export interface CurrentPrice {
  price: number;
  currency: string;
  airline: string | null;
  stops: number;
  source: string;
  capturedAt: string;
}

/**
 * Cheapest fare for one flight in the most recent capture. Both providers
 * can list the same departure, so take the best of them, not an arbitrary
 * row — otherwise a saved trip appears to jump in price.
 */
export async function currentPrice(
  origin: string,
  destination: string,
  departure: string,
): Promise<CurrentPrice | null> {
  const rows = await db.execute(sql`
    SELECT price::float8 AS price, currency, airline, stops, source,
           to_char(captured_at AT TIME ZONE 'UTC', ${sql.raw(INSTANT)}) AS captured_at
    FROM fares
    WHERE origin = ${origin} AND destination = ${destination}
      AND departure = CAST(${departure} AS timestamp)
      AND captured_at = (
        SELECT max(captured_at) FROM fares
        WHERE origin = ${origin} AND destination = ${destination}
          AND departure = CAST(${departure} AS timestamp))
    ORDER BY price ASC LIMIT 1
  `);
  const r = (rows as unknown as Array<Omit<CurrentPrice, "capturedAt"> & { captured_at: string }>)[0];
  return r ? { ...r, capturedAt: r.captured_at } : null;
}

/** Min/max price ever seen for one flight, to show the trend. */
export async function priceExtremes(
  origin: string,
  destination: string,
  departure: string,
): Promise<{ lo: number; hi: number; n: number } | null> {
  const rows = await db.execute(sql`
    SELECT min(price)::float8 AS lo, max(price)::float8 AS hi, count(*)::int AS n
    FROM fares
    WHERE origin = ${origin} AND destination = ${destination}
      AND departure = CAST(${departure} AS timestamp)
  `);
  const r = (rows as unknown as Array<{ lo: number | null; hi: number | null; n: number }>)[0];
  return r && r.lo !== null && r.hi !== null ? { lo: r.lo, hi: r.hi, n: r.n } : null;
}

export async function currentPackage(
  origin: string,
  destination: string,
  outDate: string,
  nights: number,
): Promise<{ price: number; currency: string; source: string } | null> {
  const rows = await db.execute(sql`
    SELECT price::float8 AS price, currency, source FROM package_fares
    WHERE origin = ${origin} AND destination = ${destination}
      AND out_date = CAST(${outDate} AS date) AND nights = ${nights}
    ORDER BY captured_at DESC LIMIT 1
  `);
  return (rows as unknown as Array<{ price: number; currency: string; source: string }>)[0] ?? null;
}

export async function packageExtremes(
  origin: string,
  destination: string,
  outDate: string,
  nights: number,
): Promise<{ lo: number; hi: number } | null> {
  const rows = await db.execute(sql`
    SELECT min(price)::float8 AS lo, max(price)::float8 AS hi FROM package_fares
    WHERE origin = ${origin} AND destination = ${destination}
      AND out_date = CAST(${outDate} AS date) AND nights = ${nights}
  `);
  const r = (rows as unknown as Array<{ lo: number | null; hi: number | null }>)[0];
  return r && r.lo !== null && r.hi !== null ? { lo: r.lo, hi: r.hi } : null;
}

export interface FavoriteRow {
  id: number;
  createdAt: string;
  kind: string;
  outOrigin: string;
  outDestination: string;
  outDeparture: string;
  retOrigin: string | null;
  retDestination: string | null;
  retDeparture: string | null;
  note: string | null;
  priceAtSave: number | null;
}

export async function listFavorites(): Promise<FavoriteRow[]> {
  const rows = await db.execute(sql.raw(`
    SELECT id, kind, out_origin, out_destination, ret_origin, ret_destination, note,
           to_char(created_at AT TIME ZONE 'UTC', ${INSTANT}) AS created_at,
           to_char(out_departure, ${WALL}) AS out_departure,
           to_char(ret_departure, ${WALL}) AS ret_departure,
           price_at_save::float8 AS price_at_save
    FROM favorites ORDER BY out_departure
  `));
  return (rows as unknown as RawFavorite[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    kind: r.kind,
    outOrigin: r.out_origin,
    outDestination: r.out_destination,
    outDeparture: r.out_departure,
    retOrigin: r.ret_origin,
    retDestination: r.ret_destination,
    retDeparture: r.ret_departure,
    note: r.note,
    priceAtSave: r.price_at_save,
  }));
}

// ---------- alerts ----------

export type AlertRow = typeof alerts.$inferSelect;

export async function listAlerts(): Promise<AlertRow[]> {
  return db.select().from(alerts).orderBy(alerts.id);
}

/** Trip keys not yet looked at, per alert. */
export async function unseenKeysByAlert(): Promise<Map<number, Set<string>>> {
  const rows = await db
    .select({ alertId: alertHits.alertId, tripKey: alertHits.tripKey })
    .from(alertHits)
    .where(eq(alertHits.seen, false));
  const out = new Map<number, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.alertId)) out.set(r.alertId, new Set());
    out.get(r.alertId)!.add(r.tripKey);
  }
  return out;
}

type RawFavorite = {
  id: number;
  created_at: string;
  kind: string;
  out_origin: string;
  out_destination: string;
  out_departure: string;
  ret_origin: string | null;
  ret_destination: string | null;
  ret_departure: string | null;
  note: string | null;
  price_at_save: number | null;
};

type RawFare = {
  origin: string;
  destination: string;
  departure: string;
  arrival: string | null;
  airline: string | null;
  stops: number;
  price: number;
  currency: string;
  source: string;
  captured_at: string;
};

type RawPackage = {
  origin: string;
  destination: string;
  out_date: string;
  nights: number;
  price: number;
  currency: string;
  source: string;
  captured_at: string;
};

type RawHistory = {
  captured_at: string;
  departure: string;
  airline: string | null;
  stops: number;
  price: number;
  source: string;
};
