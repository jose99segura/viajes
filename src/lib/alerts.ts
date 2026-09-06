import type { AlertRow } from "@/db/queries";
import type { Config } from "./config";
import {
  buildTrips,
  DEFAULT_FILTER,
  tripKey,
  type FareRow,
  type PackageRow,
  type Trip,
  type TripFilter,
} from "./trips";

/**
 * Alert rules re-evaluated against the latest snapshot. Port of the
 * record=False path of flighttracker/alerts.py — the read side. The write
 * side (recording hits after a fetch, so the next run can say what is new)
 * stays in Python, because that is where fetches happen.
 *
 * The two must agree on what the top matches are, or the fetcher would
 * record hits the page never shows. Same pairing (buildTrips), same sort
 * (price, then days off), same cut (30), same key (tripKey).
 */

export const MAX_MATCHES = 30;

export interface AlertMatch extends Trip {
  key: string;
  isNew: boolean;
}

export interface AlertEntry {
  alert: AlertRow;
  matches: AlertMatch[];
  /** Matches in the current top that have not been looked at. */
  unseen: number;
  /** Every pairing the rule matched, before the cut. */
  total: number;
}

export function filterFor(a: AlertRow): TripFilter {
  return {
    ...DEFAULT_FILTER,
    minNights: a.minNights || 1,
    maxNights: a.maxNights || 21,
    airport: (a.airport ?? "").toUpperCase(),
    directOnly: a.directOnly,
    maxPrice: a.maxPrice === null ? null : Number(a.maxPrice),
    maxDaysOff: a.maxDaysOff,
  };
}

export function evaluateAlerts(
  alertsList: AlertRow[],
  unseenByAlert: Map<number, Set<string>>,
  rows: FareRow[],
  packages: PackageRow[],
  cfg: Config,
): AlertEntry[] {
  return alertsList.map((alert) => {
    const entry: AlertEntry = { alert, matches: [], unseen: 0, total: 0 };
    if (!alert.enabled) return entry;

    const { trips } = buildTrips(rows, packages, cfg, filterFor(alert));
    // Python: combos.sort(key=lambda c: (c["price"], c["days_off"])) — a
    // stable sort on the effective-ordered list, so ties keep that order.
    trips.sort((a, b) => a.price - b.price || a.daysOff - b.daysOff);
    entry.total = trips.length;

    const top = trips.slice(0, MAX_MATCHES);
    const unseen = unseenByAlert.get(alert.id) ?? new Set<string>();
    entry.matches = top.map((t) => {
      const key = tripKey(t);
      return { ...t, key, isNew: unseen.has(key) };
    });
    entry.unseen = entry.matches.filter((m) => m.isNew).length;
    return entry;
  });
}
