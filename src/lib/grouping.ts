import type { Trip } from "./trips";
import { addDays, formatDate, parseWallClock, weekday } from "./wallclock";

/**
 * Twenty rows of the same route on consecutive dates say one thing, not
 * twenty. Grouping keeps the best of each (airport pair, departure week)
 * and folds the rest away, so the list shows the choices rather than the
 * noise. Port of groupKey/groupRows in static/app.js.
 */

export interface GroupedTrip {
  trip: Trip;
  key: string;
  /** How many more trips this row stands for. 0 on an expanded child. */
  more: number;
  /** True for a row revealed by expanding its group. */
  child: boolean;
}

/**
 * Identity of a group: the airport pair plus the Monday of the departure
 * week, so a Friday and a Saturday of the same weekend stay together.
 */
export function groupKey(t: Trip): string {
  const dep = parseWallClock(t.out.departure);
  const monday = addDays(dep, -weekday(dep));
  return `${t.out.origin}|${t.ret.destination}|${formatDate(monday)}`;
}

/**
 * Collapse `sorted` (already in the order the user asked for) into one row
 * per group, expanding the groups in `open`.
 *
 * The first member of each group is its best under the active sort, so
 * folding never reorders anything on its own — and an expanded group's
 * children sit directly under their parent rather than jumping the list.
 */
export function groupTrips(sorted: Trip[], open: Set<string>): GroupedTrip[] {
  const groups = new Map<string, Trip[]>();
  for (const t of sorted) {
    const k = groupKey(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  const out: GroupedTrip[] = [];
  for (const [key, members] of groups) {
    out.push({ trip: members[0], key, more: members.length - 1, child: false });
    if (open.has(key)) {
      for (const t of members.slice(1)) {
        out.push({ trip: t, key, more: 0, child: true });
      }
    }
  }
  return out;
}
