import { FlightsToolbar } from "@/components/flights/FlightsToolbar";
import { Topbar } from "@/components/shell/Topbar";
import {
  Badges,
  GroundCell,
  LegCell,
  SortHeader,
  WhenCell,
} from "@/components/trips/cells";
import { DetailCard } from "@/components/trips/DetailCard";
import { Pager, PAGE_SIZE } from "@/components/trips/Pager";
import { RowLink } from "@/components/trips/RowLink";
import { StarButton } from "@/components/trips/StarButton";
import { favoriteKeys, latestSnapshot } from "@/db/queries";
import { bookingLinkForLeg } from "@/lib/booking";
import { loadConfig } from "@/lib/config";
import { favoriteKey, type FavoriteInput } from "@/lib/favorites";
import {
  fmtAdj,
  fmtCaptured,
  fmtDep,
  fmtEUR,
  fmtEUR0,
  fmtInt,
  stopsES,
} from "@/lib/format";
import { airportGround } from "@/lib/scoring";
import { matchesWhen, scoreLeg, type FareRow, type When } from "@/lib/trips";
import { hrefWith, one, type Params } from "@/lib/url";

/**
 * "Solo ida" — every future fare in the latest snapshot, scored the same
 * way the legs of a round trip are.
 *
 * Not a route of its own: it is the "Tipo" field on the search page, so
 * switching between round trips and one ways keeps the airport, the price
 * cap and the rest of the filter bar. It renders inside "/" when
 * `kind=oneway`.
 *
 * One leg says nothing about how long the car would sit at the airport, so
 * the drive counts in the effective cost and parking does not.
 */

interface Flight extends FareRow {
  route: string;
  adjustment: number;
  label: string;
  ground: number;
  groundLabel: string;
  effective: number;
  key: string;
}

const SORTS: Record<string, (f: Flight) => number | string> = {
  route: (f) => f.route,
  departure: (f) => f.departure,
  price: (f) => f.price,
  adjustment: (f) => f.adjustment,
  ground: (f) => f.ground,
  effective: (f) => f.effective,
  label: (f) => f.label,
  source: (f) => f.source,
};

const COLS: Array<{ k: string; t: string; num?: boolean }> = [
  { k: "route", t: "Vuelo" },
  { k: "departure", t: "Salida" },
  { k: "price", t: "Precio", num: true },
  { k: "adjustment", t: "Ajuste", num: true },
  { k: "ground", t: "Coche", num: true },
  { k: "effective", t: "Efectivo", num: true },
  { k: "label", t: "Cuándo" },
  { k: "source", t: "Fuente" },
];

function flightFav(f: Flight): FavoriteInput {
  return {
    kind: "flight",
    outOrigin: f.origin,
    outDestination: f.destination,
    outDeparture: f.departure,
    retOrigin: null,
    retDestination: null,
    retDeparture: null,
    priceAtSave: f.price,
  };
}

export async function OneWayView({
  params,
  airports,
  toolbar,
}: {
  params: Params;
  airports: string[];
  /** The shared "Tipo" field, rendered inside this view's filter bar. */
  toolbar: React.ReactNode;
}) {
  const cfg = loadConfig();
  const [rows, favKeys] = await Promise.all([latestSnapshot(), favoriteKeys()]);

  let lastCaptured: string | null = null;
  const flights: Flight[] = [];
  for (const r of rows) {
    if (lastCaptured === null || r.capturedAt > lastCaptured) lastCaptured = r.capturedAt;
    const leg = scoreLeg(r, cfg);
    if (!leg) continue;
    const home = r.destination === "ALC" ? r.origin : r.destination;
    const [ground, groundLabel] = airportGround(home, cfg.travel);
    flights.push({
      ...r,
      departure: leg.departure,
      route: `${r.origin}→${r.destination}`,
      adjustment: leg.adjustment,
      label: leg.label,
      ground,
      groundLabel,
      effective: Math.round((r.price + leg.adjustment + ground) * 100) / 100,
      key: `${r.origin}|${r.destination}|${leg.departure}`,
    });
  }

  // Tiles describe the whole snapshot, as the old renderTiles() did.
  const best = flights.length
    ? flights.reduce((a, b) => (b.effective < a.effective ? b : a))
    : undefined;
  const cheapest = flights.length
    ? flights.reduce((a, b) => (b.price < a.price ? b : a))
    : undefined;

  const airport = (one(params, "airport") ?? "").toUpperCase();
  const when = (one(params, "when") ?? "") as When;
  const source = one(params, "source") ?? "";
  const maxPrice = one(params, "max_price");
  const max = maxPrice ? Number(maxPrice) : NaN;
  const direct = one(params, "direct") === "1";

  const shown = flights.filter((f) => {
    if (airport && f.origin !== airport && f.destination !== airport) return false;
    if (source && f.source !== source) return false;
    if (direct && f.stops) return false;
    if (!Number.isNaN(max) && f.price > max) return false;
    return matchesWhen(f.label, when);
  });

  const sortKey = one(params, "sort") && SORTS[one(params, "sort")!] ? one(params, "sort")! : "effective";
  const dir = one(params, "dir") === "-1" ? -1 : 1;
  const key = SORTS[sortKey];
  shown.sort((a, b) => {
    const av = key(a);
    const bv = key(b);
    return (
      (typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv))) * dir
    );
  });

  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(one(params, "page")) || 1), pages);
  const pageRows = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const sel = one(params, "sel");
  const selected = sel ? shown.find((f) => f.key === sel) : undefined;

  const sortHref = (k: string) =>
    hrefWith(params, { sort: k, dir: sortKey === k && dir === 1 ? -1 : null, page: null });

  return (
    <>
      <Topbar title="Ida y vuelta" meta={fmtCaptured(lastCaptured)} />
      <div className="content">
        <div className="tiles">
          <div className="tile">
            <div className="k">Mejor vuelo</div>
            <div className="v">{best ? fmtEUR0(best.effective) : "–"}</div>
            <div className="d">{best ? `${best.route} · ${fmtDep(best.departure)}` : ""}</div>
          </div>
          <div className="tile">
            <div className="k">Más barato</div>
            <div className="v">{cheapest ? fmtEUR0(cheapest.price) : "–"}</div>
            <div className="d">
              {cheapest
                ? `${cheapest.route} · ${fmtDep(cheapest.departure)} · ${fmtEUR0(cheapest.effective)} efectivo`
                : ""}
            </div>
          </div>
          <div className="tile">
            <div className="k">Tarifas futuras</div>
            <div className="v">{fmtInt(flights.length)}</div>
            <div className="d">
              {new Set(flights.map((f) => f.route)).size} rutas trackeadas
            </div>
          </div>
        </div>

        <FlightsToolbar
          airports={airports}
          count={`${fmtInt(shown.length)} vuelos`}
          kindField={toolbar}
          values={{
            airport,
            when,
            maxPrice: maxPrice ?? "",
            source,
            direct,
            sort: sortKey === "effective" ? undefined : sortKey,
            dir: dir === -1 ? "-1" : undefined,
          }}
        />

        {selected && (
          <DetailCard
            title={`${selected.origin} → ${selected.destination} · ${fmtDep(selected.departure)}`}
            meta={costBreakdown(selected)}
            links={[
              bookingLinkForLeg(selected.source, selected.origin, selected.destination, selected.departure),
            ]}
            series={[
              {
                origin: selected.origin,
                destination: selected.destination,
                departure: selected.departure,
                name: "precio",
                color: "--series-1",
              },
            ]}
            closeHref={hrefWith(params, { sel: null })}
          />
        )}

        <div className="card">
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="starcol" />
                  {COLS.map((c) => (
                    <SortHeader
                      key={c.k}
                      href={sortHref(c.k)}
                      active={sortKey === c.k}
                      dir={dir}
                      num={c.num}
                    >
                      {c.t}
                    </SortHeader>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!pageRows.length && (
                  <tr>
                    <td className="empty-row" colSpan={COLS.length + 1}>
                      Ningún resultado con estos filtros.
                    </td>
                  </tr>
                )}
                {pageRows.map((f) => {
                  const fav = flightFav(f);
                  return (
                    <RowLink
                      key={f.key + f.source}
                      href={hrefWith(params, { sel: f.key })}
                      selected={selected === f}
                    >
                      <td className="starcol">
                        <StarButton fav={fav} on={favKeys.has(favoriteKey(fav))} />
                      </td>
                      <td>
                        <LegCell origin={f.origin} destination={f.destination} airline={f.airline} stops={f.stops} />
                      </td>
                      <td>
                        <WhenCell departure={f.departure} />
                      </td>
                      <td className="num">{fmtEUR(f.price)}</td>
                      <td className="num adj">{fmtAdj(f.adjustment)}</td>
                      <td className="num adj" title={f.groundLabel}>
                        <GroundCell ground={f.ground} />
                      </td>
                      <td className="num">
                        <span className="eff">{fmtEUR(f.effective)}</span>
                      </td>
                      <td>
                        <Badges label={f.label} />
                      </td>
                      <td>
                        <span className="src">{f.source}</span>
                      </td>
                    </RowLink>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager params={params} page={page} total={shown.length} />
        </div>
      </div>
    </>
  );
}

/** Ticket, convenience and car spelled out, so the ranking never looks arbitrary. */
function costBreakdown(f: Flight): string {
  const bits = [`${f.airline ?? "?"} · ${stopsES(f.stops)}`, `${fmtEUR(f.price)} billete`];
  if (f.adjustment) bits.push(`${fmtAdj(f.adjustment)} ajuste`);
  if (f.ground) bits.push(`+${f.ground.toFixed(0)} € coche${f.groundLabel ? ` (${f.groundLabel})` : ""}`);
  return `${bits.join(" · ")} = ${fmtEUR(f.effective)} efectivo`;
}
