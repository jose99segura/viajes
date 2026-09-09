import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Ported from flighttracker/db.py. The Python fetcher writes these same
 * tables through pg8000, so any change here has to be matched there.
 *
 * ---------------------------------------------------------------------------
 * Two timestamp kinds, deliberately different
 * ---------------------------------------------------------------------------
 * `capturedAt` is an instant — when the fetch ran — and is `timestamptz`.
 *
 * `departure` / `arrival` are the airline's LOCAL wall-clock time with no
 * offset attached (that is exactly what both providers return). They are
 * `timestamp` WITHOUT time zone, and read back as strings.
 *
 * This is not a detail. Scoring reads the clock: a departure before 17:30 on
 * a weekday costs a day off, after it does not. Stored as `timestamptz`, the
 * hour would depend on the reader's session time zone — the container runs
 * UTC and the dev machine is Europe/Madrid, so the same row would score
 * differently in each, and `work_days_used` would disagree between the app
 * and the Python alert check. A naive wall clock has no offset to store, so
 * storing one means inventing it.
 *
 * `mode: "string"` for the same reason: a JS Date is an instant, and turning
 * one back into "the hour the plane leaves" reintroduces the zone. The
 * strings are the wall clock, byte for byte, as Python's naive datetimes are.
 */

/** Postgres renders these with a space; the canonical form uses "T". */
export const fares = pgTable(
  "fares",
  {
    id: serial("id").primaryKey(),
    /** UTC instant of the scrape. One value per fetch run, not per insert. */
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** 'ryanair' | 'google' */
    source: text("source").notNull(),
    origin: text("origin").notNull(),
    destination: text("destination").notNull(),
    departure: timestamp("departure", { mode: "string" }).notNull(),
    arrival: timestamp("arrival", { mode: "string" }),
    airline: text("airline"),
    stops: integer("stops").notNull().default(0),
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    soldOut: boolean("sold_out").notNull().default(false),
  },
  (t) => [
    index("idx_fares_route_dep").on(t.origin, t.destination, t.departure),
    index("idx_fares_captured").on(t.capturedAt),
  ],
);

/**
 * Round trips quoted as a single price for a departure date plus a trip
 * length, with no departure times (Luxair). Kept apart from `fares`, which is
 * per-leg with exact times.
 *
 * `outDate` is a `date`, not a timestamp: Luxair publishes no time of day and
 * the route flies at most once a day. The UI says "sin hora" rather than
 * inventing one, and these fares are scored on day-of-week alone.
 */
export const packageFares = pgTable(
  "package_fares",
  {
    id: serial("id").primaryKey(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** 'luxair' */
    source: text("source").notNull(),
    origin: text("origin").notNull(),
    destination: text("destination").notNull(),
    outDate: date("out_date").notNull(),
    nights: integer("nights").notNull(),
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
  },
  (t) => [index("idx_pkg_route_date").on(t.origin, t.destination, t.outDate)],
);

/**
 * Alert rules: "tell me when a trip like this exists". Each is a saved trip
 * filter plus a name; NULL means "no limit" for that field.
 */
export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  name: text("name").notNull(),
  airport: text("airport"),
  maxPrice: numeric("max_price", { precision: 10, scale: 2 }),
  maxDaysOff: integer("max_days_off"),
  minNights: integer("min_nights").notNull().default(1),
  maxNights: integer("max_nights").notNull().default(14),
  directOnly: boolean("direct_only").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
});

/**
 * Which trips have matched which alert, so a fetch can say what is NEW and
 * the sidebar can show an unread count. Rows for trips that stop matching are
 * deleted, so the same trip counts as new again if it comes back.
 *
 * `tripKey` is the canonical "ORIG|departure|ORIG|departure" string built by
 * tripKey() — the Python fetcher and the TypeScript app must produce it
 * identically or a re-fetch would flag every existing match as new.
 */
export const alertHits = pgTable(
  "alert_hits",
  {
    alertId: integer("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    tripKey: text("trip_key").notNull(),
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
    seen: boolean("seen").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.alertId, t.tripKey] })],
);

/**
 * Saved trips and flights. `kind` is 'trip' (a paired round trip), 'flight'
 * (one way) or 'package' (a Luxair whole-trip fare). The return columns are
 * NULL for a one-way favourite.
 */
export const favorites = pgTable(
  "favorites",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    outOrigin: text("out_origin").notNull(),
    outDestination: text("out_destination").notNull(),
    outDeparture: timestamp("out_departure", { mode: "string" }).notNull(),
    retOrigin: text("ret_origin"),
    retDestination: text("ret_destination"),
    retDeparture: timestamp("ret_departure", { mode: "string" }),
    note: text("note"),
    priceAtSave: numeric("price_at_save", { precision: 10, scale: 2 }),
  },
  (t) => [
    // NULLS NOT DISTINCT is the fix for a latent SQLite bug rather than a
    // change of intent. SQLite treats NULLs as distinct in a UNIQUE index, so
    // the old constraint never actually stopped a one-way favourite (all
    // three ret_* columns NULL) being saved twice — while the delete path
    // already compared them with IFNULL(...,''), i.e. as equal. This makes
    // the constraint mean what the surrounding code always assumed.
    unique("favorites_identity")
      .on(
        t.kind,
        t.outOrigin,
        t.outDestination,
        t.outDeparture,
        t.retOrigin,
        t.retDestination,
        t.retDeparture,
      )
      .nullsNotDistinct(),
  ],
);

/**
 * One row per provider attempt per fetch run.
 *
 * This is the observability table. Before it existed, the only signal that
 * the 09:00 fetch had failed was the dashboard quietly showing yesterday's
 * prices, and you found out by looking. Now every attempt records what it
 * tried, how long it took, how many fares it saw and why it stopped.
 *
 * Rows are only ever inserted, never updated, for the same reason fares are:
 * the history is what makes "when did this start failing" answerable.
 *
 * `capturedAt` is the run timestamp shared with the fares that run wrote, so
 * a snapshot and its provenance join on one column.
 */
export const fetchRuns = pgTable(
  "fetch_runs",
  {
    id: serial("id").primaryKey(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** 'ryanair' | 'luxair' | 'google' */
    provider: text("provider").notNull(),
    /** "HHN-ALC". Null for steps that are not per route. */
    route: text("route"),
    /**
     * 'ok'      the attempt succeeded and its fares were stored
     * 'failed'  the provider raised after exhausting its retries
     * 'suspect' the provider answered, but with so much less than last time
     *           that the answer was not trusted and nothing was stored
     */
    status: text("status").notNull(),
    faresFound: integer("fares_found").notNull().default(0),
    faresStored: integer("fares_stored").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    /** Exception text for 'failed', the comparison for 'suspect'. */
    error: text("error"),
  },
  (t) => [
    index("idx_runs_captured").on(t.capturedAt),
    index("idx_runs_provider").on(t.provider, t.route, t.capturedAt),
  ],
);
