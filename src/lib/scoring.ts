import type { Airport, Scoring, Travel } from "./config";
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

/**
 * Penalty for landing back near Luxembourg at night: the flight ends at the
 * airport, the day ends after an hour or two of driving. Only counted at the
 * home end — a midnight landing in Alicante costs you nothing — and only
 * when the provider publishes an arrival time (Luxair does not).
 */
export function arrivalAdjustment(
  arrival: WallClock | null,
  atHome: boolean,
  s: Scoring,
): [number, string] {
  if (arrival === null || !atHome || !s.lateArrivalPenalty) return [0, ""];
  const t = timeOfDay(arrival);
  if (t >= s.lateHour * 60 || t < s.beforeHour * 60) {
    return [s.lateArrivalPenalty, "late arrival"];
  }
  return [0, ""];
}

/** "3h30" / "45 min", as Python's _fmt_hours. */
function fmtHours(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`;
}

/** Python's round(x, 2) on values that never land on an exact half. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * What using this airport costs on top of the ticket: driving there and back
 * (fuel, wear, tolls and your hours at the wheel) plus parking while you are
 * away. `nights` is null for a single leg, where parking is unknowable.
 *
 * An airport that is not in `travel.airports` costs nothing, so adding a
 * route without measuring the drive first degrades gracefully.
 */
export function airportGround(
  code: string,
  t: Travel,
  nights: number | null = null,
): [number, string] {
  const a: Airport | undefined = t.airports[(code || "").toUpperCase()];
  if (!a) return [0, ""];
  // Rates all zero: the ground model is switched off in config.yaml. Return
  // no label as well as no cost — "3h30 de coche" next to +0 € reads as a
  // bug, and the UI hides the column when every row is zero.
  if (!t.eurPerKm && !t.eurPerHour && !a.parkingPerDay) return [0, ""];
  const drive = 2 * (a.km * t.eurPerKm + (a.driveMinutes / 60) * t.eurPerHour);
  let label = `${fmtHours(2 * a.driveMinutes)} de coche`;
  let total = drive;
  if (nights !== null) {
    // You leave the car there the day you fly out and pick it up the day
    // you land: nights + 1 calendar days of parking.
    const parking = a.parkingPerDay * (nights + 1);
    total += parking;
    if (parking) label += ` + ${parking.toFixed(0)} € parking`;
  }
  return [round2(total), label];
}

/**
 * Ground cost of a whole round trip. Normally one drive out, one back and
 * parking in between. If you fly home to a different airport the car is
 * still where you left it, so you pay both airports' driving: getting home
 * from the one you land at, and going back for the car.
 */
export function tripGround(
  outAirport: string,
  retAirport: string,
  nights: number,
  t: Travel,
): [number, string] {
  let [total, label] = airportGround(outAirport, t, nights);
  if (retAirport && retAirport.toUpperCase() !== (outAirport || "").toUpperCase()) {
    const [extra, extraLabel] = airportGround(retAirport, t);
    if (extra) {
      total += extra;
      label += ` + ${extraLabel} para recoger el coche en ${outAirport}`;
    }
  }
  return [round2(total), label];
}

/** Whether workDaysUsed() charged the departure day itself. */
function departureDayCounts(outDep: WallClock, s: Scoring, dateOnly: boolean): boolean {
  if (weekday(outDep) >= SATURDAY) return false;
  return dateOnly || timeOfDay(outDep) < s.workEnd * 60;
}

/**
 * Euros for the holiday a trip burns.
 *
 * Every Mon-Fri day it eats is charged *except the departure day*: that one
 * is already priced by the work-hours and weekday penalties on the departure
 * itself, and charging both would bill the same day twice. So a Friday 22:00
 * to Sunday trip costs nothing, and a Wednesday to Saturday one costs the two
 * days it really takes off your allowance.
 */
export function daysOffCost(
  daysOff: number,
  outDep: WallClock,
  s: Scoring,
  outDateOnly = false,
): [number, string] {
  if (!daysOff || !s.dayOffCost) return [0, ""];
  const charged = daysOff - (departureDayCounts(outDep, s, outDateOnly) ? 1 : 0);
  if (charged <= 0) return [0, ""];
  // Deliberately unnumbered: the charge covers fewer days than the trip's
  // days-off count (the departure day is excluded), and showing "10" next to
  // a badge saying "11" reads as a bug rather than as the rule it is.
  return [round2(charged * s.dayOffCost), "vacaciones"];
}
