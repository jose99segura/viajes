import Link from "next/link";
import type { BookingLink } from "@/lib/booking";
import { PriceChart, type Series } from "./PriceChart";

/**
 * The card that opens above the table when a row is selected: title, a
 * one-line summary, booking links, and the price history chart. Closing it
 * is a link to the same URL without `sel`.
 */
export function DetailCard({
  title,
  meta,
  links,
  series,
  closeHref,
}: {
  title: string;
  meta: string;
  links: BookingLink[];
  series: Series[];
  closeHref: string;
}) {
  return (
    <div className="detail open" id="detail">
      <div className="card">
        <Link href={closeHref} className="close" title="Cerrar" scroll={false}>
          ✕
        </Link>
        <h2>{title}</h2>
        <div className="meta">{meta}</div>
        <div className="book-links">
          {links.map((l) => (
            <a
              key={l.url}
              className={`book-link${l.muted ? " muted" : ""}`}
              href={l.url}
              target="_blank"
              rel="noopener"
              title={l.title}
            >
              {l.label} ↗
            </a>
          ))}
        </div>
        {series.length > 1 && (
          <div className="legend">
            {series.map((s) => (
              <span key={s.name} className="item">
                <span
                  className="swatch"
                  style={{ background: `var(${s.color})` }}
                />{" "}
                {s.name}
              </span>
            ))}
          </div>
        )}
        <div id="chartHost">
          {/* Keyed on the selection so a new row mounts a fresh chart. */}
          <PriceChart
            key={series.map((s) => `${s.origin}${s.destination}${s.departure}`).join()}
            series={series}
          />
        </div>
      </div>
    </div>
  );
}
