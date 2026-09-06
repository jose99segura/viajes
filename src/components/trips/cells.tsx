import { labelParts, stopsES, whenParts } from "@/lib/format";

/** Table cells shared by "Ida y vuelta" and "Solo ida". */

export function LegCell({
  origin,
  destination,
  airline,
  stops,
}: {
  origin: string;
  destination: string;
  airline: string | null;
  stops: number;
}) {
  return (
    <span className="leg">
      <span className="code">
        {origin}
        <span className="arr">→</span>
        {destination}
      </span>
      <span className="op">
        {airline || "–"} ·{" "}
        <span className={stops ? undefined : "direct"}>{stopsES(stops)}</span>
      </span>
    </span>
  );
}

export function WhenCell({
  departure,
  dateOnly,
}: {
  departure: string;
  dateOnly?: boolean;
}) {
  const { day, time } = whenParts(departure);
  return (
    <span className="when">
      <span className="day">{day}</span>
      {/* Luxair fares carry no departure time; say so rather than show a fake 00:00. */}
      {dateOnly ? (
        <span className="time" style={{ color: "var(--muted)" }}>
          sin hora
        </span>
      ) : (
        <span className="time">{time}</span>
      )}
    </span>
  );
}

/** 0 days off is the thing worth spotting, so it reads as a win, not a zero. */
export function DaysOff({ days }: { days: number }) {
  if (days === 0) return <span className="badge good">ninguno</span>;
  return <span className={`badge${days <= 1 ? "" : " warn"}`}>{days}</span>;
}

export function Badges({ label }: { label: string }) {
  return (
    <span className="badges">
      {labelParts(label).map((p, i) => (
        <span key={i} className={`badge${p.tone ? ` ${p.tone}` : ""}`}>
          {p.text}
        </span>
      ))}
    </span>
  );
}

/** Sortable column header: a link that flips direction on the active key. */
export function SortHeader({
  href,
  active,
  dir,
  num,
  children,
}: {
  href: string;
  active: boolean;
  dir: 1 | -1;
  num?: boolean;
  children: React.ReactNode;
}) {
  return (
    <th className={num ? "num" : undefined}>
      <a href={href} className="block text-inherit no-underline">
        {children}
        <span className="arrow">{active ? (dir === 1 ? "▲" : "▼") : ""}</span>
      </a>
    </th>
  );
}
