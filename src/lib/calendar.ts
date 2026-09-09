import type { Config } from "./config";
import { airportGround } from "./scoring";
import { scoreLeg, type FareRow } from "./trips";

/**
 * The price calendars: colour ramp and the per-day minima. Port of the
 * calendar half of static/app.js.
 */

/**
 * Sequential blue ramp. Inverted from the usual light→dark = low→high:
 * cheap should stand out, so cheap = strong accent, expensive = faint.
 */
export const CAL_RAMP = [
  "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95",
];

/**
 * Colour for a price within [lo, hi] on a log scale — fares cluster low with
 * a long expensive tail, and a linear scale paints most days the same.
 */
export function rampColor(price: number, lo: number, hi: number): string {
  if (hi === lo) return CAL_RAMP[0];
  const t = (Math.log(price) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return CAL_RAMP[Math.min(CAL_RAMP.length - 1, Math.floor(t * CAL_RAMP.length))];
}

/** Text must flip to white on the dark half of the ramp. */
export const isDarkRamp = (color: string) => CAL_RAMP.indexOf(color) >= 3;

/** The best fare of one day, and what made it the best. */
export interface DayBest {
  day: string;
  price: number;
  effective: number;
  airport: string;
  airline: string | null;
}

/**
 * Best fare per calendar day per direction, ranked the way the rest of the
 * app ranks: by effective cost, not by ticket price. Otherwise a 22 € fare
 * from an airport two hours away paints a greener day than a 107 € one from
 * the airport down the road, and the calendar contradicts the trip list.
 *
 * Parking is left out — one day cell says nothing about how long the car
 * would wait — so a day's effective cost is the ticket, the convenience
 * adjustment and the drive there and back.
 */
export function dailyBest(
  rows: FareRow[],
  airport: string,
  cfg: Config,
): {
  outbound: Record<string, DayBest>;
  inbound: Record<string, DayBest>;
  airports: string[];
} {
  const outbound: Record<string, DayBest> = {};
  const inbound: Record<string, DayBest> = {};
  const airports = new Set<string>();
  for (const r of rows) {
    let home: string;
    let target: Record<string, DayBest>;
    if (r.destination === "ALC") {
      home = r.origin;
      target = outbound;
    } else if (r.origin === "ALC") {
      home = r.destination;
      target = inbound;
    } else {
      continue;
    }
    airports.add(home);
    if (airport && home !== airport) continue;
    const leg = scoreLeg(r, cfg);
    if (!leg) continue;
    const [ground] = airportGround(home, cfg.travel);
    const effective = Math.round((r.price + leg.adjustment + ground) * 100) / 100;
    const day = leg.departure.slice(0, 10);
    const current = target[day];
    if (!current || effective < current.effective) {
      target[day] = {
        day,
        price: Math.round(r.price * 100) / 100,
        effective,
        airport: home,
        airline: r.airline,
      };
    }
  }
  return { outbound, inbound, airports: [...airports].sort() };
}

const MONTHS_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** "noviembre de 2026", as toLocaleDateString("es-ES", {month:"long", year:"numeric"}). */
export function monthLabel(year: number, month: number): string {
  return `${MONTHS_LONG[month - 1]} de ${year}`;
}

/** "YYYY-MM" → [year, month]; invalid → null. */
export function parseMonth(text: string | undefined): [number, number] | null {
  const m = /^(\d{4})-(\d{2})$/.exec(text ?? "");
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? [Number(m[1]), month] : null;
}

export function addMonths(year: number, month: number, n: number): [number, number] {
  const i = year * 12 + (month - 1) + n;
  return [Math.floor(i / 12), (i % 12) + 1];
}

export const monthParam = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;

/**
 * Today's calendar date in the tracker's zone. The one place a Date and a
 * zone are legitimately used on the calendar: "now" is an instant, and
 * which month to open first depends on where the user is.
 */
export function todayMonth(): [number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Luxembourg",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  return [year, month];
}
