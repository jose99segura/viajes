import { RemoveFavorite } from "@/components/favorites/RemoveFavorite";
import { Topbar } from "@/components/shell/Topbar";
import {
  currentPackage,
  currentPrice,
  listFavorites,
  packageExtremes,
  priceExtremes,
  type FavoriteRow,
} from "@/db/queries";
import { bookingLinkForLeg, type BookingLink } from "@/lib/booking";
import { fmtDep, fmtEUR } from "@/lib/format";
import type { FavoriteInput } from "@/lib/favorites";
import { dayNumber, parseWallClock } from "@/lib/wallclock";

/**
 * "Favoritos" — saved trips and flights, each showing today's price, the
 * range seen so far, and the movement since saving. Port of the
 * /api/favorites handler in web.py plus renderFavs() in app.js.
 */

export const metadata = { title: "Favoritos" };

interface LegView {
  origin: string;
  destination: string;
  departure: string;
  dateOnly: boolean;
  airline: string | null;
  source: string | null;
  price: number | null;
  low: number | null;
  high: number | null;
}

interface FavView {
  row: FavoriteRow;
  legs: LegView[];
  isPackage: boolean;
  priceNow: number | null;
  delta: number | null;
  nights: number | null;
  links: BookingLink[];
}

async function enrich(row: FavoriteRow): Promise<FavView> {
  if (row.kind === "package" && row.retDeparture) {
    // One quoted price for the whole trip; look it up as such.
    const outDay = row.outDeparture.slice(0, 10);
    const nights =
      dayNumber(parseWallClock(row.retDeparture)) - dayNumber(parseWallClock(outDay));
    const [now, ext] = await Promise.all([
      currentPackage(row.outOrigin, row.outDestination, outDay, nights),
      packageExtremes(row.outOrigin, row.outDestination, outDay, nights),
    ]);
    const priceNow = now?.price ?? null;
    return {
      row,
      isPackage: true,
      nights,
      priceNow,
      delta:
        row.priceAtSave && priceNow ? Math.round((priceNow - row.priceAtSave) * 100) / 100 : null,
      legs: [
        {
          origin: row.outOrigin,
          destination: row.outDestination,
          departure: row.outDeparture,
          dateOnly: true,
          airline: "Luxair",
          source: "luxair",
          price: priceNow,
          low: ext?.lo ?? null,
          high: ext?.hi ?? null,
        },
        {
          origin: row.outDestination,
          destination: row.outOrigin,
          departure: row.retDeparture,
          dateOnly: true,
          airline: "Luxair",
          source: "luxair",
          price: null,
          low: null,
          high: null,
        },
      ],
      links: [bookingLinkForLeg("luxair", row.outOrigin, row.outDestination, row.outDeparture)],
    };
  }

  const legSpecs: Array<[string, string, string]> = [
    [row.outOrigin, row.outDestination, row.outDeparture],
  ];
  if (row.retDeparture && row.retOrigin && row.retDestination) {
    legSpecs.push([row.retOrigin, row.retDestination, row.retDeparture]);
  }

  let totalNow = 0;
  const legs: LegView[] = [];
  for (const [origin, destination, departure] of legSpecs) {
    const [now, ext] = await Promise.all([
      currentPrice(origin, destination, departure),
      priceExtremes(origin, destination, departure),
    ]);
    const price = now?.price ?? null;
    if (price !== null) totalNow += price;
    legs.push({
      origin,
      destination,
      departure,
      dateOnly: false,
      airline: now?.airline ?? null,
      source: now?.source ?? null,
      price,
      low: ext?.lo ?? null,
      high: ext?.hi ?? null,
    });
  }
  const priceNow = totalNow ? Math.round(totalNow * 100) / 100 : null;
  const isTrip = legs.length === 2;

  let links: BookingLink[];
  if (!isTrip) {
    links = [bookingLinkForLeg(legs[0].source ?? "", legs[0].origin, legs[0].destination, legs[0].departure)];
  } else if (legs[0].source === "ryanair" && legs[1].source === "ryanair") {
    links = [bookingLinkForLeg("ryanair", legs[0].origin, "ALC", legs[0].departure, legs[1].departure)];
  } else {
    links = [
      bookingLinkForLeg(legs[0].source ?? "", legs[0].origin, "ALC", legs[0].departure),
      bookingLinkForLeg(legs[1].source ?? "", "ALC", legs[1].destination, legs[1].departure),
    ];
  }

  return {
    row,
    isPackage: false,
    nights: isTrip
      ? dayNumber(parseWallClock(legs[1].departure)) - dayNumber(parseWallClock(legs[0].departure))
      : null,
    priceNow,
    delta: row.priceAtSave && priceNow ? Math.round((priceNow - row.priceAtSave) * 100) / 100 : null,
    legs,
    links,
  };
}

function toInput(row: FavoriteRow): FavoriteInput {
  return {
    kind: row.kind,
    outOrigin: row.outOrigin,
    outDestination: row.outDestination,
    outDeparture: row.outDeparture,
    retOrigin: row.retOrigin,
    retDestination: row.retDestination,
    retDeparture: row.retDeparture,
  };
}

export default async function FavoritesPage() {
  const rows = await listFavorites();
  const favs = await Promise.all(rows.map(enrich));

  return (
    <>
      <Topbar title="Favoritos" />
      <div className="content">
        <div className="fav-grid">
          {!favs.length && (
            <div className="chat-empty" style={{ gridColumn: "1 / -1", padding: "30px 0" }}>
              Todavía no has guardado nada. Pulsa la ☆ en cualquier vuelo o viaje —
              o pídeselo al asistente y guarda su recomendación.
            </div>
          )}
          {favs.map((f) => (
            <div key={f.row.id} className="fav">
              <RemoveFavorite fav={toInput(f.row)} />
              <h3>
                {f.legs[0].origin} → {f.legs[0].destination}
                {f.legs.length === 2 ? ` → ${f.legs[1].destination}` : ""}
              </h3>
              <div className="sub">
                {f.nights != null ? `${f.nights} noches · ` : ""}guardado{" "}
                {f.row.createdAt.slice(0, 10)}
              </div>
              {f.legs.map((l, i) => (
                <div key={i} className="leg">
                  <span className="l">
                    {l.origin} → {l.destination}
                    <br />
                    <span style={{ color: "var(--muted)", fontSize: 11.5 }}>
                      {l.dateOnly ? `${fmtDep(l.departure, true)} · sin hora` : fmtDep(l.departure)} ·{" "}
                      {l.airline || "?"}
                    </span>
                  </span>
                  <span className="r">
                    {l.price == null ? (f.isPackage ? "" : "—") : fmtEUR(l.price)}
                    {l.low != null && l.high != null && l.high > l.low && (
                      <>
                        {" "}
                        <span style={{ color: "var(--muted)" }}>
                          ({Math.round(l.low)}–{Math.round(l.high)})
                        </span>
                      </>
                    )}
                  </span>
                </div>
              ))}
              <div className="total">
                <span style={{ color: "var(--ink-2)", fontSize: 12.5 }}>total ahora</span>
                <span>
                  <span className="v">{f.priceNow != null ? fmtEUR(f.priceNow) : "—"}</span>{" "}
                  {f.delta != null && Math.abs(f.delta) >= 0.5 && (
                    <span className={`delta ${f.delta < 0 ? "down" : "up"}`}>
                      {f.delta < 0 ? "▼" : "▲"} {fmtEUR(Math.abs(f.delta))}
                    </span>
                  )}
                </span>
              </div>
              <div className="book-links">
                {f.links.map((l) => (
                  <a
                    key={l.url}
                    className={`book-link small${l.muted ? " muted" : ""}`}
                    href={l.url}
                    target="_blank"
                    rel="noopener"
                    title={l.title}
                  >
                    {l.label} ↗
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
