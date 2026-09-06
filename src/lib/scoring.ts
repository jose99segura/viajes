import type { Scoring } from "./config";
import {
  addDays,
  dayNumber,
  startOfDay,
  weekday,
  type WallClock,
} from "./wallclock";

/**
 * Price → effective cost. Port of flighttracker/scoring.py.
 *
 * The Python copy still exists and still runs: the fetcher evaluates alert
 * rules right after each snapshot, and it needs the same numbers. Both read
 * their weights from config.yaml, and tests/equivalence.test.ts scores the
 * same fixture through both and asserts identical output. If you change a
 * branch here, change it there, then run `pnpm test`.
 *
 * Labels are part of the contract, not decoration: the "when" filter matches
 * on them ("weekend", "fri evening", "work hours", "weekday") and they must
 * be the exact strings Python produces.
 */

const FRIDAY = 4;
const SATURDAY = 5;
const SUNDAY = 6;

/** Seconds since midnight, so a config clock ("17:30") compares exactly. */
function timeOfDay(w: WallClock): number {
  return w.minutes * 60 + w.seconds;
}

/**
 * Euros to add to (or subtract from) the price based on how much the
 * departure time disrupts a normal work week. Returns [adjustment, label].
 */
export function convenienceAdjustment(
  departure: WallClock,
  s: Scoring,
): [number, string] {
  let adj = 0;
  const labels: string[] = [];
  const wd = weekday(departure);
  const t = timeOfDay(departure);
  const workStart = s.workStart * 60;
  const workEnd = s.workEnd * 60;

  if (wd === SATURDAY || wd === SUNDAY) {
    adj -= s.weekendBonus;
    labels.push("weekend");
  } else if (wd === FRIDAY) {
    if (t >= workEnd) {
      adj -= s.fridayEveningBonus;
      labels.push("fri evening");
    } else if (workStart <= t && t < workEnd) {
      adj += s.workHoursPenalty;
      labels.push("work hours");
    }
  } else {
    // Mon-Thu
    adj += s.weekdayPenalty;
    labels.push("weekday");
    if (workStart <= t && t < workEnd) {
      adj += s.workHoursPenalty;
      labels.push("work hours");
    }
  }

  if (t < s.beforeHour * 60) {
    adj += s.earlyPenalty;
    labels.push("early");
  }

  return [adj, labels.join(", ") || "ok"];
}

/**
 * Convenience adjustment when only the date is known, not the time (Luxair
 * quotes fares per date). Applies the weekday/weekend part of the scoring
 * and skips everything that depends on the clock — so these fares are never
 * penalised for a work-hours departure we cannot actually see.
 */
export function dayAdjustment(day: WallClock, s: Scoring): [number, string] {
  const wd = weekday(day);
  if (wd === SATURDAY || wd === SUNDAY) return [-s.weekendBonus, "weekend"];
  if (wd === FRIDAY) return [0, "friday"];
  return [s.weekdayPenalty, "weekday"];
}

export function effectiveCost(
  price: number,
  departure: WallClock,
  s: Scoring,
): number {
  return price + convenienceAdjustment(departure, s)[0];
}

/**
 * How many Mon-Fri days you would need off work for this trip.
 *
 * The departure day counts unless you leave after work (>= workEnd). The
 * return day counts whenever it is a weekday: even an early flight home
 * lands during working hours. Every weekday in between counts. When only a
 * date is known (Luxair) the day is counted — better to overstate a day off
 * than to sell a trip as free when it is not.
 *
 * `retDateOnly` is accepted for signature parity with the Python function,
 * which also never reads it: the return day counts either way.
 */
export function workDaysUsed(
  outDep: WallClock,
  retDep: WallClock,
  s: Scoring,
  outDateOnly = false,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  retDateOnly = false,
): number {
  let days = 0;
  const outDay = dayNumber(outDep);
  const last = dayNumber(retDep);
  let day = startOfDay(outDep);
  for (let n = outDay; n <= last; n++, day = addDays(day, 1)) {
    if (weekday(day) < SATURDAY) {
      if (n === outDay && !outDateOnly) {
        if (timeOfDay(outDep) < s.workEnd * 60) days += 1;
      } else {
        days += 1;
      }
    }
  }
  return days;
}
