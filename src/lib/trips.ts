import type { Config } from "./config";
import {
  convenienceAdjustment,
  dayAdjustment,
  workDaysUsed,
} from "./scoring";
import {
  addDays,
  canonical,
  dayNumber,
  formatWallClock,
  parseWallClock,
  serial,
  startOfDay,
  type WallClock,
} from "./wallclock";

/**
 * Round-trip assembly: pair outbound legs (X→ALC) with return legs (ALC→X),
 * score each pairing, and mix in Luxair's whole-trip fares. Port of
 * flighttracker/trips.py.
 *
 * Pure: it takes the latest snapshot as rows and returns trips. The database
 * query lives in src/db/queries.ts so that this can be run over a fixture —
 * which is how tests/equivalence.test.ts proves it agrees with the Python
 * copy that the fetcher's alert check still uses.
 *
 * Iteration order is part of the contract. Trips are built outbound-major
 * in snapshot order, packages appended, then stably sorted by effective
 * cost. Python does the same, and stable sorts on both sides mean ties
 * resolve identically — so the top-N an alert records is the same top-N.
 */

export interface FareRow {
  origin: string;
  destination: string;
  /** Wall clock, "T" or space separated. */
  departure: string;
  arrival?: string | null;
  airline: string | null;
  stops: number;
  price: number;
  currency: string;
  source: string;
  /** ISO instant, comparable as text. */
  capturedAt: string;
}

export interface PackageRow {
  origin: string;
  destination: string;
  /** "YYYY-MM-DD" */
  outDate: string;
  nights: number;
  price: number;
  currency: string;
  source: string;
  capturedAt: string;
}

export type When = "" | "weekend" | "fri" | "convenient" | "weekday";

export interface TripFilter {
  minNights: number;
  maxNights: number;
  /** Home airport (LUX/SCN/HHN); "" = any. */
  airport: string;
  when: When;
  /** Return to the same airport you left from. */
  sameOnly: boolean;
  directOnly: boolean;
  maxPrice: number | null;
  /** Work days the trip may consume. */
  maxDaysOff: number | null;
}

export const DEFAULT_FILTER: TripFilter = {
  minNights: 1,
  maxNights: 21,
  airport: "",
  when: "",
  sameOnly: false,
  directOnly: false,
  maxPrice: null,
  maxDaysOff: null,
};

export interface Leg {
  origin: string;
  destination: string;
  /** Canonical "YYYY-MM-DDTHH:MM:SS". */
  departure: string;
  airline: string | null;
  stops: number;
  /** null for a package leg: the price belongs to the whole trip. */
  price: number | null;
  adjustment: number;
  label: string;
  source: string;
  /** Luxair: no departure time is known. */
  dateOnly?: boolean;
}

export interface Trip {
  out: Leg;
  ret: Leg;
  nights: number;
  daysOff: number;
  sameAirport: boolean;
  isPackage: boolean;
  price: number;
  adjustment: number;
  effective: number;
}

export function matchesWhen(label: string, when: When): boolean {
  if (!when) return true;
  if (when === "weekend") return label.includes("weekend");
  if (when === "fri") return label.includes("fri evening");
  if (when === "convenient")
    return label.includes("weekend") || label.includes("fri evening");
  if (when === "weekday")
    return label.includes("weekday") || label.includes("work hours");
  return true;
}

/**
 * Stable identity for a pairing, used to remember alert hits. Must be byte
 * for byte what Python's trip_key produces: the fetcher writes these into
 * alert_hits and the app reads them back.
 */
export function tripKey(trip: Trip): string {
  return [
    trip.out.origin,
    trip.out.departure,
    trip.ret.destination,
    trip.ret.departure,
  ].join("|");
}

/** Python's round(x, 2) on values that never land on an exact half. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

interface ScoredLeg extends Leg {
  dep: WallClock;
}

/**
 * All pairings that pass the filter, cheapest-effective first, plus the
 * timestamp of the most recent capture they were built from.
 */
export function buildTrips(
  rows: FareRow[],
  packages: PackageRow[],
  cfg: Config,
  f: TripFilter,
): { trips: Trip[]; lastCaptured: string | null } {
  const outbounds: ScoredLeg[] = [];
  const returns: ScoredLeg[] = [];
  let lastCaptured: string | null = null;

  for (const r of rows) {
    let dep: WallClock;
    try {
      dep = parseWallClock(r.departure);
    } catch {
      continue;
    }
    const [adjustment, label] = convenienceAdjustment(dep, cfg.scoring);
    const leg: ScoredLeg = {
      origin: r.origin,
      destination: r.destination,
      departure: canonical(r.departure),
      airline: r.airline,
      stops: r.stops,
      price: r.price,
      adjustment,
      label,
      source: r.source,
      dep,
    };
    // Before the filters, as in Python: the snapshot age is a property of
    // the data, not of what the user asked to see.
    if (lastCaptured === null || r.capturedAt > lastCaptured) {
      lastCaptured = r.capturedAt;
    }
    if (f.directOnly && r.stops) continue;
    if (r.destination === "ALC") {
      if (f.airport && r.origin !== f.airport) continue;
      if (!matchesWhen(label, f.when)) continue;
      outbounds.push(leg);
    } else if (r.origin === "ALC") {
      if (f.airport && r.destination !== f.airport) continue;
      returns.push(leg);
    }
  }

  const trips: Trip[] = [];
  for (const out of outbounds) {
    for (const ret of returns) {
      const nights = dayNumber(ret.dep) - dayNumber(out.dep);
      if (nights < f.minNights || nights > f.maxNights) continue;
      if (nights === 0 && serial(ret.dep) <= serial(out.dep)) continue;
      if (f.sameOnly && out.origin !== ret.destination) continue;
      const price = (out.price as number) + (ret.price as number);
      if (f.maxPrice !== null && price > f.maxPrice) continue;
      const daysOff = workDaysUsed(out.dep, ret.dep, cfg.scoring);
      if (f.maxDaysOff !== null && daysOff > f.maxDaysOff) continue;
      trips.push({
        out: stripDep(out),
        ret: stripDep(ret),
        nights,
        daysOff,
        sameAirport: out.origin === ret.destination,
        isPackage: false,
        price: round2(price),
        adjustment: out.adjustment + ret.adjustment,
        effective: round2(price + out.adjustment + ret.adjustment),
      });
    }
  }

  trips.push(...packageTrips(packages, cfg, f));
  // Array.prototype.sort is stable (ES2019), as Python's list.sort is.
  trips.sort((a, b) => a.effective - b.effective);
  return { trips, lastCaptured };
}

function stripDep(leg: ScoredLeg): Leg {
  // Same key order as the Python dict, for anyone diffing the two.
  return {
    origin: leg.origin,
    destination: leg.destination,
    departure: leg.departure,
    airline: leg.airline,
    stops: leg.stops,
    price: leg.price,
    adjustment: leg.adjustment,
    label: leg.label,
    source: leg.source,
  };
}

/**
 * Luxair round trips, shaped like the paired ones so the UI can mix them.
 *
 * Non-stop and quoted whole, but with no departure times, so they are
 * scored on the day of week only (dayAdjustment) and their days-off count
 * is conservative (workDaysUsed with dateOnly).
 */
function packageTrips(
  packages: PackageRow[],
  cfg: Config,
  f: TripFilter,
): Trip[] {
  const out: Trip[] = [];
  for (const r of packages) {
    if (f.airport && r.origin !== f.airport && r.destination !== f.airport)
      continue;
    if (!(f.minNights <= r.nights && r.nights <= f.maxNights)) continue;
    if (f.maxPrice !== null && r.price > f.maxPrice) continue;
    let outDay: WallClock;
    try {
      outDay = startOfDay(parseWallClock(r.outDate));
    } catch {
      continue;
    }
    const retDay = addDays(outDay, r.nights);
    const [outAdj, outLabel] = dayAdjustment(outDay, cfg.scoring);
    const [retAdj, retLabel] = dayAdjustment(retDay, cfg.scoring);
    if (!matchesWhen(outLabel, f.when)) continue;
    const daysOff = workDaysUsed(outDay, retDay, cfg.scoring, true, true);
    if (f.maxDaysOff !== null && daysOff > f.maxDaysOff) continue;
    out.push({
      out: {
        origin: r.origin,
        destination: r.destination,
        departure: formatWallClock(outDay),
        dateOnly: true,
        airline: "Luxair",
        stops: 0,
        price: null,
        adjustment: outAdj,
        label: outLabel,
        source: "luxair",
      },
      ret: {
        origin: r.destination,
        destination: r.origin,
        departure: formatWallClock(retDay),
        dateOnly: true,
        airline: "Luxair",
        stops: 0,
        price: null,
        adjustment: retAdj,
        label: retLabel,
        source: "luxair",
      },
      nights: r.nights,
      daysOff,
      sameAirport: true,
      isPackage: true,
      price: r.price,
      adjustment: outAdj + retAdj,
      effective: round2(r.price + outAdj + retAdj),
    });
  }
  return out;
}
