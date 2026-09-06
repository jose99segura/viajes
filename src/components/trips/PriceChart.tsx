"use client";

import { useEffect, useRef, useState } from "react";
import { fmtEUR } from "@/lib/format";

/**
 * Price history, one line per leg. Port of drawChart() in static/app.js.
 *
 * Fetches /api/history for each series after mount — the history is only
 * wanted once a row is clicked, and it is the one thing on the page that
 * is not part of the snapshot. Colours are CSS variables in `style`, so the
 * chart follows a theme switch without redrawing.
 */

export interface Series {
  origin: string;
  destination: string;
  /** Canonical wall clock; picks the exact flight out of the day's rows. */
  departure: string;
  name: string;
  color: "--series-1" | "--series-2";
}

interface Point {
  t: number;
  price: number;
}

interface Loaded extends Series {
  pts: Point[];
}

const MONTHS = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

async function fetchSeries(s: Series): Promise<Loaded> {
  const day = s.departure.slice(0, 10);
  const q = new URLSearchParams({
    origin: s.origin,
    destination: s.destination,
    day,
  });
  const res = await fetch(`/api/history?${q}`);
  const data = (await res.json()) as {
    points: Array<{ captured_at: string; departure: string; price: number }>;
  };
  const exact = data.points.filter((p) => p.departure === s.departure);
  const pts = (exact.length ? exact : data.points)
    .map((p) => ({ t: new Date(p.captured_at).getTime(), price: p.price }))
    .sort((a, b) => a.t - b.t);
  return { ...s, pts };
}

const W = 900;
const H = 220;
const M = { top: 14, right: 16, bottom: 26, left: 54 };
const IW = W - M.left - M.right;
const IH = H - M.top - M.bottom;

export function PriceChart({ series }: { series: Series[] }) {
  // Starts empty and is filled once. The parent remounts this component
  // (key = the series identity) when the selection changes, which is what
  // resets it — no state reset inside the effect.
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [hover, setHover] = useState<{ t: number; x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let alive = true;
    Promise.all(series.map(fetchSeries)).then((all) => {
      if (alive) setLoaded(all.filter((s) => s.pts.length));
    });
    return () => {
      alive = false;
    };
    // The series array is new each render but its contents are fixed for
    // the life of this mount (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loaded === null) return <div className="empty">Cargando…</div>;
  if (!loaded.length) {
    return (
      <div className="empty">
        Sin histórico todavía. Cada <code>fetch</code> añade un punto.
      </div>
    );
  }

  const all = loaded.flatMap((s) => s.pts);
  const ts = all.map((p) => p.t);
  const ps = all.map((p) => p.price);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  let p0 = Math.min(...ps);
  let p1 = Math.max(...ps);
  if (p0 === p1) {
    p0 -= 5;
    p1 += 5;
  }
  const pad = (p1 - p0) * 0.15;
  p0 -= pad;
  p1 += pad;
  const X = (t: number) =>
    t1 === t0 ? M.left + IW / 2 : M.left + ((t - t0) / (t1 - t0)) * IW;
  const Y = (p: number) => M.top + (1 - (p - p0) / (p1 - p0)) * IH;

  const times = [...new Set(ts)].sort((a, b) => a - b);
  const fmtT = (t: number) => {
    const d = new Date(t);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  };
  const xLabels: Array<{ t: number; label: string }> = [];
  const shown = new Set<string>();
  for (const t of times) {
    const label = fmtT(t);
    if (shown.has(label)) continue;
    shown.add(label);
    xLabels.push({ t, label });
  }

  function onMove(ev: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * (W / rect.width);
    let best = times[0];
    let bd = Infinity;
    for (const t of times) {
      const d = Math.abs(X(t) - mx);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    setHover({
      t: best,
      x: Math.min(ev.clientX + 14, window.innerWidth - 160),
      y: ev.clientY + 14,
    });
  }

  const hoverDate = hover ? new Date(hover.t) : null;

  return (
    <>
      <svg
        ref={svgRef}
        id="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Evolución del precio"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 1, 2, 3, 4].map((i) => {
          const v = p0 + ((p1 - p0) * i) / 4;
          const y = Y(v);
          return (
            <g key={i}>
              <line
                x1={M.left}
                y1={y}
                x2={W - M.right}
                y2={y}
                style={{ stroke: "var(--grid)" }}
                strokeWidth={1}
              />
              <text
                x={M.left - 9}
                y={y + 4}
                textAnchor="end"
                fontSize={11}
                style={{ fill: "var(--muted)" }}
              >
                {Math.round(v)} €
              </text>
            </g>
          );
        })}
        <line
          x1={M.left}
          y1={M.top + IH}
          x2={W - M.right}
          y2={M.top + IH}
          style={{ stroke: "var(--baseline)" }}
          strokeWidth={1}
        />
        {xLabels.map(({ t, label }) => (
          <text
            key={t}
            x={X(t)}
            y={H - 8}
            textAnchor="middle"
            fontSize={11}
            style={{ fill: "var(--muted)" }}
          >
            {label}
          </text>
        ))}
        {loaded.map((s) => (
          <g key={s.name}>
            <path
              d={s.pts
                .map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.price).toFixed(1)}`)
                .join(" ")}
              fill="none"
              style={{ stroke: `var(${s.color})` }}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {s.pts.map((p) => (
              <circle
                key={p.t}
                cx={X(p.t)}
                cy={Y(p.price)}
                r={4}
                style={{ fill: `var(${s.color})`, stroke: "var(--surface)" }}
                strokeWidth={2}
              />
            ))}
          </g>
        ))}
        {hover && (
          <line
            x1={X(hover.t)}
            x2={X(hover.t)}
            y1={M.top}
            y2={M.top + IH}
            style={{ stroke: "var(--baseline)" }}
            strokeWidth={1}
          />
        )}
      </svg>
      {hover && hoverDate && (
        <div
          className="tooltip"
          style={{ display: "block", left: hover.x, top: hover.y }}
        >
          <div className="t">
            {hoverDate.getDate()} {MONTHS[hoverDate.getMonth()]}{" "}
            {String(hoverDate.getHours()).padStart(2, "0")}:
            {String(hoverDate.getMinutes()).padStart(2, "0")}
          </div>
          {loaded.map((s) => {
            const p = s.pts.find((p) => p.t === hover.t);
            return p ? (
              <div key={s.name} className="p">
                {loaded.length > 1 ? `${s.name}: ` : ""}
                {fmtEUR(p.price)}
              </div>
            ) : null;
          })}
        </div>
      )}
    </>
  );
}
