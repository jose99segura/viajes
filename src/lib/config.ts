import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/**
 * config.yaml, parsed. Port of flighttracker/config.py.
 *
 * The Python fetcher reads the same file for the same numbers. That is the
 * arrangement that stops the two scoring implementations drifting: neither
 * side owns a copy of the weights, so a change to config.yaml reaches both
 * or neither. Do not add a default here that config.py does not also apply.
 *
 * Clock values ("09:00") become minutes since midnight. That is a number a
 * wall clock can be compared against without ever constructing a Date, and
 * a Date is where a time zone would sneak in — see src/db/schema.ts.
 */

export interface Route {
  origin: string;
  destination: string;
}

export interface Scoring {
  workHoursPenalty: number;
  /** Minutes since midnight. */
  workStart: number;
  workEnd: number;
  weekdayPenalty: number;
  fridayEveningBonus: number;
  weekendBonus: number;
  beforeHour: number;
  earlyPenalty: number;
  /** Landing back home after this hour means a night drive. */
  lateHour: number;
  lateArrivalPenalty: number;
  /** What a day of holiday is worth. */
  dayOffCost: number;
}

/** What it takes to reach one of the home airports by car, one way. */
export interface Airport {
  km: number;
  driveMinutes: number;
  parkingPerDay: number;
}

/** Ground costs: the part of a trip the airline does not charge you for. */
export interface Travel {
  eurPerKm: number;
  eurPerHour: number;
  airports: Record<string, Airport>;
}

export interface GoogleSampling {
  weeks: number;
  /** 0 = Monday … 6 = Sunday, as Python's weekday(). */
  weekdays: number[];
}

export interface LuxairSampling {
  routes: Array<[string, string]>;
  nights: number[];
}

export interface Config {
  routes: Route[];
  monthsAhead: number;
  currency: string;
  scoring: Scoring;
  travel: Travel;
  google: GoogleSampling;
  luxair: LuxairSampling;
}

export function parseClock(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

type RawConfig = {
  routes: Route[];
  months_ahead?: number;
  currency?: string;
  scoring: Record<string, string | number>;
  travel?: {
    eur_per_km?: number;
    eur_per_hour?: number;
    airports?: Record<string, { km?: number; drive_minutes?: number; parking_per_day?: number }>;
  };
  google?: { weeks?: number; weekdays?: number[] };
  luxair?: { routes?: Array<[string, string]>; nights?: number[] };
};

export function parseConfig(text: string): Config {
  const raw = parse(text) as RawConfig;
  const s = raw.scoring;
  const g = raw.google ?? {};
  const lx = raw.luxair ?? {};
  const tr = raw.travel ?? {};
  const airports: Record<string, Airport> = {};
  for (const [code, a] of Object.entries(tr.airports ?? {})) {
    airports[code.toUpperCase()] = {
      km: Number(a.km ?? 0),
      driveMinutes: Number(a.drive_minutes ?? 0),
      parkingPerDay: Number(a.parking_per_day ?? 0),
    };
  }
  return {
    routes: raw.routes,
    // Same fallbacks as config.py, so a trimmed config.yaml means the same
    // thing to both halves.
    monthsAhead: Number(raw.months_ahead ?? 3),
    currency: raw.currency ?? "EUR",
    scoring: {
      workHoursPenalty: Number(s.work_hours_penalty),
      workStart: parseClock(String(s.work_start)),
      workEnd: parseClock(String(s.work_end)),
      weekdayPenalty: Number(s.weekday_penalty),
      fridayEveningBonus: Number(s.friday_evening_bonus),
      weekendBonus: Number(s.weekend_bonus),
      beforeHour: parseClock(String(s.before_hour)),
      earlyPenalty: Number(s.early_penalty),
      lateHour: parseClock(String(s.late_hour ?? "22:30")),
      lateArrivalPenalty: Number(s.late_arrival_penalty ?? 0),
      dayOffCost: Number(s.day_off_cost ?? 0),
    },
    travel: {
      eurPerKm: Number(tr.eur_per_km ?? 0),
      eurPerHour: Number(tr.eur_per_hour ?? 0),
      airports,
    },
    google: {
      weeks: Number(g.weeks ?? 6),
      weekdays: g.weekdays ?? [4, 5, 6],
    },
    luxair: {
      routes: (lx.routes ?? []).map(([a, b]) => [a, b]),
      nights: lx.nights ?? [3, 7, 14],
    },
  };
}

/**
 * The file sits at the repo root, next to the Python package, and is copied
 * to the image root by the Dockerfile — so process.cwd() is right in both
 * development and the standalone server.
 */
export const CONFIG_PATH = path.join(process.cwd(), "config.yaml");

let cached: Config | undefined;

/**
 * Read once per process. The file only changes with a deploy, and the
 * scoring functions are called per fare per request.
 */
export function loadConfig(): Config {
  if (!cached) {
    cached = parseConfig(readFileSync(CONFIG_PATH, "utf-8"));
  }
  return cached;
}
