/**
 * Wall-clock arithmetic with no time zone anywhere.
 *
 * Departures are stored as the airline's local time with no offset (see
 * src/db/schema.ts), and scoring compares them against clock values from
 * config.yaml: before 17:30 on a weekday costs a day off, after it does not.
 * A JS Date is an instant, and every route from an instant back to "what
 * hour is it" passes through a zone — the container's UTC, the browser's
 * Europe/Madrid — so a Date is never constructed here. Everything is done
 * on the components, and the only Date API touched is Date.UTC, which is a
 * pure function of its arguments.
 *
 * This mirrors what the Python side gets for free from a naive datetime.
 */

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  /** Minutes since midnight. */
  minutes: number;
  /** Seconds within the minute — kept so "T22:00:30" > "T22:00:00". */
  seconds: number;
}

const PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * Accepts "2026-09-03T17:20:00" (the canonical form, and what Python's
 * isoformat produces), "2026-09-03 17:20:00" (what Postgres renders a
 * `timestamp` as) and a bare "2026-09-03" (midnight, as Python's
 * datetime.combine(day, time.min) gives Luxair fares).
 */
export function parseWallClock(text: string): WallClock {
  const m = PATTERN.exec(text);
  if (!m) throw new Error(`Not a wall clock: ${JSON.stringify(text)}`);
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    minutes: Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0),
    seconds: Number(m[6] ?? 0),
  };
}

/** Canonical form, "2026-09-03T17:20:00" — what trip keys are built from. */
export function formatWallClock(w: WallClock): string {
  const hh = Math.floor(w.minutes / 60);
  const mm = w.minutes % 60;
  return `${formatDate(w)}T${pad(hh)}:${pad(mm)}:${pad(w.seconds)}`;
}

export function formatDate(w: WallClock): string {
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/**
 * Normalise a stored value to the canonical "T" form without parsing it in
 * full. Used wherever a string from the database becomes part of a trip key
 * or a favourite identity: Postgres renders timestamps with a space, and the
 * Python side, the UI and the existing alert_hits rows all use "T".
 */
export function canonical(text: string): string {
  return text.length >= 16 && text[10] === " "
    ? text.slice(0, 10) + "T" + text.slice(11)
    : text;
}

/** Days since 1970-01-01 for this calendar date. Zone-free. */
export function dayNumber(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day) / 86_400_000;
}

/** Monday = 0 … Sunday = 6, matching Python's datetime.weekday(). */
export function weekday(w: WallClock): number {
  // Date.UTC's getUTCDay is Sunday = 0; 1970-01-01 was a Thursday. Doing it
  // on the day number keeps it a pure calculation.
  return (((dayNumber(w) + 3) % 7) + 7) % 7;
}

/** Ordering key: later wall clocks compare greater. */
export function serial(w: WallClock): number {
  return dayNumber(w) * 86_400 + w.minutes * 60 + w.seconds;
}

export function addDays(w: WallClock, days: number): WallClock {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    minutes: w.minutes,
    seconds: w.seconds,
  };
}

/** Midnight of the same date. */
export function startOfDay(w: WallClock): WallClock {
  return { ...w, minutes: 0, seconds: 0 };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
