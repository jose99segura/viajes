import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import {
  convenienceAdjustment,
  dayAdjustment,
  workDaysUsed,
} from "@/lib/scoring";
import {
  buildTrips,
  DEFAULT_FILTER,
  tripKey,
  type FareRow,
  type PackageRow,
  type TripFilter,
  type When,
} from "@/lib/trips";
import {
  canonical,
  formatWallClock,
  parseWallClock,
  weekday,
} from "@/lib/wallclock";

/**
 * The one test that matters for the Python/TypeScript split.
 *
 * Scoring and pairing exist twice: here, for the app, and in
 * flighttracker/scoring.py + trips.py, for the fetcher's alert check. Both
 * read config.yaml, but both also carry the branching — which days count,
 * where 17:30 falls, how ties sort. This runs the same fixture through the
 * TypeScript side and compares against what the Python side produced
 * (tests/fixtures/expected.json, written by scripts/score_fixture.py).
 *
 * The fixture is real snapshot rows plus synthetic fares sitting exactly on
 * the boundaries (09:00, 17:30, 06:30), because real data rarely hits them
 * and that is where a `<` against a `<=` would otherwise hide.
 */

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures");

type Fixture = {
  fares: Array<{
    captured_at: string;
    source: string;
    origin: string;
    destination: string;
    departure: string;
    arrival: string | null;
    airline: string | null;
    stops: number;
    price: number;
    currency: string;
    sold_out: boolean;
  }>;
  packages: Array<{
    captured_at: string;
    source: string;
    origin: string;
    destination: string;
    out_date: string;
    nights: number;
    price: number;
    currency: string;
  }>;
  filters: Array<{ name: string; filter: Record<string, unknown> }>;
};

type Expected = {
  legs: Array<{ departure: string; adjustment: number; label: string }>;
  package_days: Array<{ out_date: string; adjustment: number; label: string }>;
  days_off: Array<{
    out: string;
    ret: string;
    days: number;
    days_date_only: number;
  }>;
  filters: Array<{
    name: string;
    last_captured: string | null;
    count: number;
    trips: Array<{
      key: string;
      nights: number;
      days_off: number;
      same_airport: boolean;
      package: boolean;
      price: number;
      adjustment: number;
      ground: number;
      ground_label: string;
      holiday: number;
      holiday_label: string;
      effective: number;
      out_label: string;
      ret_label: string;
      out_adjustment: number;
      ret_adjustment: number;
    }>;
  }>;
};

const fixture = JSON.parse(
  readFileSync(path.join(FIXTURES, "fixture.json"), "utf-8"),
) as Fixture;
const expected = JSON.parse(
  readFileSync(path.join(FIXTURES, "expected.json"), "utf-8"),
) as Expected;
const cfg = loadConfig();

const fares: FareRow[] = fixture.fares.map((f) => ({
  origin: f.origin,
  destination: f.destination,
  departure: f.departure,
  arrival: f.arrival,
  airline: f.airline,
  stops: f.stops,
  price: f.price,
  currency: f.currency,
  source: f.source,
  capturedAt: f.captured_at,
}));

const packages: PackageRow[] = fixture.packages.map((p) => ({
  origin: p.origin,
  destination: p.destination,
  outDate: p.out_date,
  nights: p.nights,
  price: p.price,
  currency: p.currency,
  source: p.source,
  capturedAt: p.captured_at,
}));

/** Python's TripFilter(**kwargs): snake_case, missing keys take defaults. */
function toFilter(raw: Record<string, unknown>): TripFilter {
  return {
    minNights: (raw.min_nights as number) ?? DEFAULT_FILTER.minNights,
    maxNights: (raw.max_nights as number) ?? DEFAULT_FILTER.maxNights,
    airport: (raw.airport as string) ?? "",
    when: ((raw.when as When) ?? "") as When,
    sameOnly: (raw.same_only as boolean) ?? false,
    directOnly: (raw.direct_only as boolean) ?? false,
    maxPrice: (raw.max_price as number) ?? null,
    maxDaysOff: (raw.max_days_off as number) ?? null,
  };
}

describe("wall clock", () => {
  it("parses the T form, the Postgres space form, and a bare date", () => {
    const a = parseWallClock("2026-09-03T17:20:00");
    const b = parseWallClock("2026-09-03 17:20:00");
    const c = parseWallClock("2026-09-03");
    expect(a).toEqual(b);
    expect(a.minutes).toBe(17 * 60 + 20);
    expect(c.minutes).toBe(0);
    expect(formatWallClock(b)).toBe("2026-09-03T17:20:00");
  });

  it("canonicalises without parsing", () => {
    expect(canonical("2026-09-03 17:20:00")).toBe("2026-09-03T17:20:00");
    expect(canonical("2026-09-03T17:20:00")).toBe("2026-09-03T17:20:00");
    expect(canonical("2026-09-03")).toBe("2026-09-03");
  });

  it("numbers weekdays like Python: Monday 0 … Sunday 6", () => {
    // 2026-10-05 is a Monday; 2026-10-11 a Sunday; 1970-01-01 a Thursday.
    expect(weekday(parseWallClock("2026-10-05"))).toBe(0);
    expect(weekday(parseWallClock("2026-10-09"))).toBe(4);
    expect(weekday(parseWallClock("2026-10-11"))).toBe(6);
    expect(weekday(parseWallClock("1970-01-01"))).toBe(3);
  });
});

describe("matches the Python implementation", () => {
  it("scores every leg identically", () => {
    expect(fixture.fares.length).toBe(expected.legs.length);
    const mismatches: string[] = [];
    fixture.fares.forEach((f, i) => {
      const [adj, label] = convenienceAdjustment(
        parseWallClock(f.departure),
        cfg.scoring,
      );
      const e = expected.legs[i];
      if (adj !== e.adjustment || label !== e.label) {
        mismatches.push(
          `${f.departure}: ts ${adj} "${label}" vs py ${e.adjustment} "${e.label}"`,
        );
      }
    });
    expect(mismatches).toEqual([]);
  });

  it("scores every package day identically", () => {
    fixture.packages.forEach((p, i) => {
      const [adj, label] = dayAdjustment(
        parseWallClock(p.out_date),
        cfg.scoring,
      );
      expect([p.out_date, adj, label]).toEqual([
        p.out_date,
        expected.package_days[i].adjustment,
        expected.package_days[i].label,
      ]);
    });
  });

  it("counts days off identically across the boundary fares", () => {
    const mismatches: string[] = [];
    for (const e of expected.days_off) {
      const o = parseWallClock(e.out);
      const r = parseWallClock(e.ret);
      const days = workDaysUsed(o, r, cfg.scoring);
      const dateOnly = workDaysUsed(o, r, cfg.scoring, true, true);
      if (days !== e.days || dateOnly !== e.days_date_only) {
        mismatches.push(
          `${e.out} → ${e.ret}: ts ${days}/${dateOnly} vs py ${e.days}/${e.days_date_only}`,
        );
      }
    }
    expect(expected.days_off.length).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });

  for (const entry of fixture.filters) {
    it(`pairs and ranks identically for filter "${entry.name}"`, () => {
      const want = expected.filters.find((f) => f.name === entry.name)!;
      const { trips, lastCaptured } = buildTrips(
        fares,
        packages,
        cfg,
        toFilter(entry.filter),
      );

      expect(lastCaptured).toBe(want.last_captured);
      expect(trips.length).toBe(want.count);

      // Same trips, in the same order — the order is what an alert's top-N
      // is cut from.
      const mismatches: string[] = [];
      trips.forEach((t, i) => {
        const e = want.trips[i];
        const got = {
          key: tripKey(t),
          nights: t.nights,
          days_off: t.daysOff,
          same_airport: t.sameAirport,
          package: t.isPackage,
          price: t.price,
          adjustment: t.adjustment,
          ground: t.ground,
          ground_label: t.groundLabel,
          holiday: t.holiday,
          holiday_label: t.holidayLabel,
          effective: t.effective,
          out_label: t.out.label,
          ret_label: t.ret.label,
          out_adjustment: t.out.adjustment,
          ret_adjustment: t.ret.adjustment,
        };
        for (const k of Object.keys(got) as Array<keyof typeof got>) {
          const a = got[k];
          const b = e[k];
          const same =
            typeof a === "number" && typeof b === "number"
              ? Math.abs(a - b) < 1e-9
              : a === b;
          if (!same) {
            mismatches.push(`#${i} ${e.key} ${k}: ts ${a} vs py ${b}`);
          }
        }
      });
      expect(mismatches).toEqual([]);
    });
  }
});

describe("the committed oracle is current", () => {
  // Guards against the case this whole file exists for: someone edits
  // scoring.py, forgets scoring.ts, and the stale expected.json keeps the
  // TypeScript tests green. Re-runs the Python side and diffs it against
  // the file. Skipped where Python is not installed (the Docker build).
  const python = spawnSync("python", ["--version"], { encoding: "utf-8" });
  const available = python.status === 0;

  it.skipIf(!available)("regenerating expected.json changes nothing", () => {
    const run = spawnSync("python", ["scripts/score_fixture.py"], {
      cwd: ROOT,
      encoding: "utf-8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(expected);
  });
});
