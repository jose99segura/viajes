import type { Config } from "@/lib/config";
import { convenienceAdjustment, workDaysUsed } from "@/lib/scoring";
import type { FareRow, PackageRow } from "@/lib/trips";
import {
  addDays,
  dayNumber,
  parseWallClock,
  startOfDay,
  weekday,
  type WallClock,
} from "@/lib/wallclock";

/**
 * The current snapshot rendered as compact text for the system prompt.
 * Port of build_context() in flighttracker/chat.py.
 *
 * The whole point is that the model sees the actual data, not a vague
 * summary: routes and ranges, the best legs each way, Luxair's whole-trip
 * fares, and the best round trips with their work-days-off count.
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "%a %d %b %H:%M", as the Python side formats it. */
function fmtDt(w: WallClock): string {
  const hh = String(Math.floor(w.minutes / 60)).padStart(2, "0");
  const mm = String(w.minutes % 60).padStart(2, "0");
  return `${DAYS[weekday(w)]} ${String(w.day).padStart(2, "0")} ${MONTHS[w.month - 1]} ${hh}:${mm}`;
}

/** "%a %d %b %Y" */
function fmtDay(w: WallClock): string {
  return `${DAYS[weekday(w)]} ${String(w.day).padStart(2, "0")} ${MONTHS[w.month - 1]} ${w.year}`;
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

interface Leg {
  origin: string;
  destination: string;
  dep: WallClock;
  departure: string;
  airline: string;
  stops: number;
  price: number;
  effective: number;
  label: string;
}

export function buildContext(
  rows: FareRow[],
  packages: PackageRow[],
  captures: { n: number; first: string | null; last: string | null },
  cfg: Config,
  maxTrips = 60,
  maxLegs = 60,
): string {
  const s = cfg.scoring;
  const parts: string[] = [
    "# Scoring weights (euros)",
    `work-hours departure (Mon-Fri ${clock(s.workStart)}-${clock(s.workEnd)}): +${s.workHoursPenalty.toFixed(0)}`,
    `weekday (Mon-Thu) departure: +${s.weekdayPenalty.toFixed(0)}`,
    `Friday after ${clock(s.workEnd)}: -${s.fridayEveningBonus.toFixed(0)}`,
    `Saturday/Sunday: -${s.weekendBonus.toFixed(0)}`,
    `before ${clock(s.beforeHour)}: +${s.earlyPenalty.toFixed(0)}`,
    "",
    `# Snapshot history: ${captures.n} captures, from ${captures.first} to ${captures.last} (UTC)`,
    "",
  ];

  const outbound: Leg[] = [];
  const inbound: Leg[] = [];
  const byRoute = new Map<string, number[]>();
  for (const r of rows) {
    let dep: WallClock;
    try {
      dep = parseWallClock(r.departure);
    } catch {
      continue;
    }
    const [adj, label] = convenienceAdjustment(dep, s);
    const leg: Leg = {
      origin: r.origin,
      destination: r.destination,
      dep,
      departure: r.departure,
      airline: r.airline || "?",
      stops: r.stops,
      price: r.price,
      effective: r.price + adj,
      label,
    };
    const key = `${r.origin}->${r.destination}`;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key)!.push(r.price);
    (r.destination === "ALC" ? outbound : inbound).push(leg);
  }

  parts.push("# Routes tracked (price range of current snapshot)");
  for (const route of [...byRoute.keys()].sort()) {
    const prices = byRoute.get(route)!;
    parts.push(
      `${route}: ${prices.length} fares, ${Math.min(...prices).toFixed(0)}-${Math.max(...prices).toFixed(0)} EUR`,
    );
  }
  parts.push("");

  const render = (legs: Leg[], title: string, limit: number) => {
    const best = [...legs].sort((a, b) => a.effective - b.effective).slice(0, limit);
    parts.push(`# ${title} (best ${best.length} by effective cost)`);
    parts.push("route | departure | airline | stops | price | effective | when");
    for (const x of best) {
      parts.push(
        `${x.origin}->${x.destination} | ${fmtDt(x.dep)} | ${x.airline} | ${x.stops} | ` +
          `${x.price.toFixed(2)} | ${x.effective.toFixed(2)} | ${x.label}`,
      );
    }
    parts.push("");
  };
  render(outbound, "Outbound legs to ALC", maxLegs);
  render(inbound, "Return legs from ALC", maxLegs);

  // Best round trips, so the model can answer "when should I go" directly.
  const combos: Array<{ eff: number; out: Leg; ret: Leg; nights: number }> = [];
  for (const out of outbound) {
    for (const ret of inbound) {
      const nights = dayNumber(ret.dep) - dayNumber(out.dep);
      if (nights < 1 || nights > 21) continue;
      combos.push({ eff: out.effective + ret.effective, out, ret, nights });
    }
  }

  // Luxair sells LUX-ALC as a whole round trip with no departure times, so
  // it cannot be paired leg-by-leg like the rest.
  if (packages.length) {
    const pkgs = [...packages].sort((a, b) => a.price - b.price).slice(0, 40);
    parts.push(
      "# Luxair non-stop round trips (LUX-ALC, whole-trip price, NO departure " +
        "times published — dates only). These are the only non-stop LUX options; " +
        "Google's LUX itineraries all have connections.",
    );
    parts.push("route | out date | nights | return date | price (round trip)");
    for (const p of pkgs) {
      const outDay = startOfDay(parseWallClock(p.outDate));
      const back = addDays(outDay, p.nights);
      parts.push(
        `${p.origin}->${p.destination} | ${fmtDay(outDay)} | ${p.nights} | ${fmtDay(back)} | ${p.price.toFixed(2)}`,
      );
    }
    parts.push("");
  }

  combos.sort((a, b) => a.eff - b.eff);
  parts.push(`# Best round trips (top ${Math.min(maxTrips, combos.length)} by effective cost)`);
  parts.push("out | departure | back | return | nights | work days off | price | effective");
  for (const c of combos.slice(0, maxTrips)) {
    const daysOff = workDaysUsed(c.out.dep, c.ret.dep, s);
    parts.push(
      `${c.out.origin}->ALC | ${fmtDt(c.out.dep)} | ALC->${c.ret.destination} | ${fmtDt(c.ret.dep)} | ` +
        `${c.nights} | ${daysOff} | ${(c.out.price + c.ret.price).toFixed(2)} | ${c.eff.toFixed(2)}`,
    );
  }
  parts.push("");
  parts.push(
    "'work days off' = Mon-Fri days the user would need off work for that trip " +
      "(a Friday departure after 17:30 costs none; any weekday return day counts). " +
      "The user strongly prefers 0, accepts 1 (Friday or Monday) for a good " +
      "price, and more only for a real bargain. Always state this number when " +
      "recommending a trip.",
  );
  return parts.join("\n");
}
