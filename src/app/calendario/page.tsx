import Link from "next/link";
import { CalendarToolbar } from "@/components/calendar/CalendarToolbar";
import { MonthGrid } from "@/components/calendar/MonthGrid";
import { Topbar } from "@/components/shell/Topbar";
import { latestSnapshot } from "@/db/queries";
import {
  addMonths,
  CAL_RAMP,
  dailyBest,
  monthParam,
  parseMonth,
  todayMonth,
} from "@/lib/calendar";
import { loadConfig } from "@/lib/config";
import { fmtCaptured, fmtEUR } from "@/lib/format";
import { hrefWith, one, type Params } from "@/lib/url";

/**
 * "Calendario" — two months at a time, each day coloured by its cheapest
 * fare on a log scale. Clicking a day opens "Ida y vuelta" narrowed to trips
 * leaving that day (and to the chosen airport).
 */

export const metadata = { title: "Calendario" };

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const cfg = loadConfig();
  const rows = await latestSnapshot();

  const airport = (one(params, "airport") ?? "").toUpperCase();
  const dir = one(params, "dir") === "inbound" ? "inbound" : "outbound";
  const [year, month] = parseMonth(one(params, "month")) ?? todayMonth();

  const { outbound, inbound, airports } = dailyBest(rows, airport, cfg);
  const best = dir === "outbound" ? outbound : inbound;
  // Coloured by effective cost, like every other view.
  const days: Record<string, number> = {};
  const titles: Record<string, string> = {};
  for (const [iso, d] of Object.entries(best)) {
    days[iso] = d.effective;
    titles[iso] =
      `${iso} · ${d.airport}${d.airline ? ` ${d.airline}` : ""} · ` +
      `${fmtEUR(d.price)} billete → ${fmtEUR(d.effective)} efectivo`;
  }
  const values = Object.values(days);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;

  let lastCaptured: string | null = null;
  for (const r of rows) {
    if (lastCaptured === null || r.capturedAt > lastCaptured) lastCaptured = r.capturedAt;
  }

  const [py, pm] = addMonths(year, month, -1);
  const [ny, nm] = addMonths(year, month, 1);
  const [y2, m2] = addMonths(year, month, 1);

  // A day links into the trips list. The return calendar has no "arrive on"
  // filter, so it links with the airport only, as the old UI did.
  const hrefFor = (iso: string) =>
    dir === "outbound"
      ? hrefWith({}, { airport: airport || null, depart: iso }, "/")
      : hrefWith({}, { airport: airport || null }, "/");

  return (
    <>
      <Topbar title="Calendario" meta={fmtCaptured(lastCaptured)} />
      <div className="content">
        <CalendarToolbar
          airport={airport}
          dir={dir}
          month={one(params, "month")}
          airports={airports}
        />

        <div className="cal-head">
          <h2>
            {dir === "outbound"
              ? "Coste efectivo más bajo por día — ida hacia Alicante"
              : "Coste efectivo más bajo por día — vuelta desde Alicante"}
          </h2>
          <div className="nav">
            <Link href={hrefWith(params, { month: monthParam(py, pm) })} role="button">
              ‹
            </Link>
            <Link href={hrefWith(params, { month: monthParam(ny, nm) })} role="button">
              ›
            </Link>
          </div>
          <div className="grow" style={{ flex: 1 }} />
          <div className="cal-legend">
            <span>barato</span>
            <span className="ramp">
              {CAL_RAMP.map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </span>
            <span>caro</span>
          </div>
        </div>

        <div className="cal-months">
          <MonthGrid
            year={year}
            month={month}
            prices={days}
            lo={lo}
            hi={hi}
            hrefFor={hrefFor}
            titles={titles}
          />
          <MonthGrid
            year={y2}
            month={m2}
            prices={days}
            lo={lo}
            hi={hi}
            hrefFor={hrefFor}
            titles={titles}
          />
        </div>
      </div>
    </>
  );
}
