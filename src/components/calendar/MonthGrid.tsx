import Link from "next/link";
import { isDarkRamp, monthLabel, rampColor } from "@/lib/calendar";
import { fmtEUR } from "@/lib/format";
import { dayNumber, weekday } from "@/lib/wallclock";

/**
 * One month of day cells coloured by price. Port of monthGrid() in
 * static/app.js, shared by the calendar page and the per-alert calendar.
 *
 * Days are computed from year/month/day numbers only (wallclock.ts), so the
 * grid is the same whatever zone the server runs in.
 */
export function MonthGrid({
  year,
  month,
  prices,
  lo,
  hi,
  hrefFor,
  selected,
  outlined,
  titles,
}: {
  year: number;
  month: number;
  /** ISO day → price. */
  prices: Record<string, number>;
  lo: number;
  hi: number;
  /** Where a priced day links to. */
  hrefFor: (isoDay: string) => string;
  selected?: string;
  /** Days to outline (an alert's new matches). */
  outlined?: Set<string>;
  /** ISO day -> title text; falls back to the day and its price. */
  titles?: Record<string, string>;
}) {
  const first = weekday({ year, month, day: 1, minutes: 0, seconds: 0 }); // Mon = 0
  const total =
    dayNumber({ year: month === 12 ? year + 1 : year, month: month === 12 ? 1 : month + 1, day: 1, minutes: 0, seconds: 0 }) -
    dayNumber({ year, month, day: 1, minutes: 0, seconds: 0 });

  const cells: React.ReactNode[] = [];
  for (let i = 0; i < first; i++) {
    cells.push(<div key={`b${i}`} className="day blank" />);
  }
  for (let d = 1; d <= total; d++) {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const price = prices[iso];
    const wd = weekday({ year, month, day: d, minutes: 0, seconds: 0 });
    const wknd = wd >= 5 ? " wknd" : "";
    if (price === undefined) {
      cells.push(
        <div key={iso} className={`day none${wknd}`}>
          <span className="n">{d}</span>
        </div>,
      );
      continue;
    }
    const bg = rampColor(price, lo, hi);
    cells.push(
      <Link
        key={iso}
        href={hrefFor(iso)}
        className={`day has${wknd}${selected === iso ? " sel" : ""}`}
        style={{
          background: bg,
          color: isDarkRamp(bg) ? "#fff" : "#0b0b0b",
          outline: outlined?.has(iso) ? "2px solid var(--accent)" : undefined,
        }}
        title={titles?.[iso] ?? `${iso} · ${fmtEUR(price)}`}
      >
        <span className="n">{d}</span>
        <span className="p">{Math.round(price)}€</span>
      </Link>,
    );
  }

  return (
    <div className="month">
      <h3>{monthLabel(year, month)}</h3>
      <div className="dow">
        {["lu", "ma", "mi", "ju", "vi", "sá", "do"].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="days">{cells}</div>
    </div>
  );
}
