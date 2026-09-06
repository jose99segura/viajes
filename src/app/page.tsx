import { Topbar } from "@/components/shell/Topbar";
import { DetailCard } from "@/components/trips/DetailCard";
import { Pager, PAGE_SIZE } from "@/components/trips/Pager";
import { RowLink } from "@/components/trips/RowLink";
import { StarButton } from "@/components/trips/StarButton";
import { TripsToolbar } from "@/components/trips/TripsToolbar";
import { favoriteKeys, latestPackages, latestSnapshot } from "@/db/queries";
import { favoriteKey, type FavoriteInput } from "@/lib/favorites";
import { bookingLinksForTrip } from "@/lib/booking";
import { loadConfig } from "@/lib/config";
import {
  fmtAdj,
  fmtCaptured,
  fmtDep,
  fmtEUR,
  fmtEUR0,
  fmtInt,
  labelParts,
  stopsES,
  whenParts,
} from "@/lib/format";
import {
  buildTrips,
  tripKey,
  type Trip,
  type TripFilter,
  type When,
} from "@/lib/trips";
import { hrefWith, one, type Params } from "@/lib/url";

/**
 * "Ida y vuelta" — paired round trips ranked by effective cost.
 *
 * Everything the old app.js kept in `state` is a query parameter here:
 * filters, sort, page, selected row. Pairing and filtering happen in this
 * Server Component, before any cap. There are tens of thousands of
 * pairings and a global top-N would hide every LUX trip behind cheaper
 * Ryanair ones — the reason the Flask API filtered server-side too.
 */

export const metadata = { title: "Ida y vuelta" };

/** The Flask API's cap: the list is cut here, then sorted as asked. */
const TRIP_CAP = 2000;

const SORTS: Record<string, (t: Trip) => number | string> = {
  out_route: (t) => t.out.origin,
  out_dep: (t) => t.out.departure,
  ret_route: (t) => t.ret.destination,
  ret_dep: (t) => t.ret.departure,
  nights: (t) => t.nights,
  days_off: (t) => t.daysOff,
  price: (t) => t.price,
  adjustment: (t) => t.adjustment,
  effective: (t) => t.effective,
  when: (t) => t.out.label,
};

const COLS: Array<{ k: string; t: string; num?: boolean }> = [
  { k: "out_route", t: "Ida" },
  { k: "out_dep", t: "Salida" },
  { k: "ret_route", t: "Vuelta" },
  { k: "ret_dep", t: "Regreso" },
  { k: "nights", t: "Noches", num: true },
  { k: "days_off", t: "Días libres", num: true },
  { k: "price", t: "Precio", num: true },
  { k: "adjustment", t: "Ajuste", num: true },
  { k: "effective", t: "Efectivo", num: true },
  { k: "when", t: "Cuándo" },
];

/** Same names and defaults as the Flask /api/trips + the old toolbar. */
function filterFrom(p: Params): TripFilter {
  const num = (k: string, d: number) => {
    const v = Number(one(p, k));
    return Number.isFinite(v) && one(p, k) !== undefined ? v : d;
  };
  const maxPrice = one(p, "max_price");
  const maxDays = one(p, "max_days_off");
  return {
    minNights: num("min_nights", 1),
    maxNights: num("max_nights", 14),
    airport: (one(p, "airport") ?? "").toUpperCase(),
    when: (one(p, "when") ?? "") as When,
    sameOnly: one(p, "same_airport") === "1",
    directOnly: one(p, "direct") === "1",
    maxPrice: maxPrice ? Number(maxPrice) : null,
    maxDaysOff: maxDays !== undefined && maxDays !== "" ? Number(maxDays) : null,
  };
}

function tripFav(t: Trip): FavoriteInput {
  return {
    kind: t.isPackage ? "package" : "trip",
    outOrigin: t.out.origin,
    outDestination: "ALC",
    outDeparture: t.out.departure,
    retOrigin: "ALC",
    retDestination: t.ret.destination,
    retDeparture: t.ret.departure,
    priceAtSave: t.price,
  };
}

export default async function TripsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const filter = filterFrom(params);
  const cfg = loadConfig();

  const [rows, packages, favKeys] = await Promise.all([
    latestSnapshot(),
    latestPackages(),
    favoriteKeys(),
  ]);

  const airports = [
    ...new Set(rows.map((r) => (r.destination === "ALC" ? r.origin : r.destination))),
  ]
    .filter((a) => a !== "ALC")
    .sort();

  const { trips: all, lastCaptured } = buildTrips(rows, packages, cfg, filter);
  const total = all.length;
  const capped = total > TRIP_CAP;
  const trips = all.slice(0, TRIP_CAP);

  // Tiles read the effective ranking, before the user's sort.
  const best = trips[0];
  const cheapest = trips.length
    ? trips.reduce((a, b) => (b.price < a.price ? b : a))
    : undefined;

  const sortKey = one(params, "sort") && SORTS[one(params, "sort")!] ? one(params, "sort")! : "effective";
  const dir = one(params, "dir") === "-1" ? -1 : 1;
  if (sortKey !== "effective" || dir !== 1) {
    const key = SORTS[sortKey];
    trips.sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      return (
        (typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv))) * dir
      );
    });
  }

  const pages = Math.max(1, Math.ceil(trips.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(one(params, "page")) || 1), pages);
  const pageRows = trips.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const sel = one(params, "sel");
  const selected = sel ? trips.find((t) => tripKey(t) === sel) : undefined;

  const sortHref = (k: string) =>
    hrefWith(params, {
      sort: k,
      dir: sortKey === k && dir === 1 ? -1 : null,
      page: null,
    });

  return (
    <>
      <Topbar title="Ida y vuelta" meta={fmtCaptured(lastCaptured)} />
      <div className="content">
        <div className="tiles">
          <div className="tile">
            <div className="k">Mejor viaje</div>
            <div className="v">{best ? fmtEUR0(best.effective) : "–"}</div>
            <div className="d">
              {best
                ? `${best.out.origin}→ALC ${fmtDep(best.out.departure, best.out.dateOnly)} · ${best.nights} noches · ${fmtEUR0(best.price)} real`
                : "sin resultados"}
            </div>
          </div>
          <div className="tile">
            <div className="k">Más barato</div>
            <div className="v">{cheapest ? fmtEUR0(cheapest.price) : "–"}</div>
            <div className="d">
              {cheapest
                ? `${cheapest.out.origin}→ALC ${fmtDep(cheapest.out.departure, cheapest.out.dateOnly)} · ${cheapest.nights} noches`
                : ""}
            </div>
          </div>
          <div className="tile">
            <div className="k">Combinaciones</div>
            <div className="v">{fmtInt(total)}</div>
            <div className="d">
              {!total
                ? "prueba a relajar los filtros"
                : capped
                  ? `mostrando las ${fmtInt(trips.length)} mejores`
                  : "idas × vueltas emparejadas"}
            </div>
          </div>
        </div>

        <TripsToolbar
          airports={airports}
          count={`${fmtInt(trips.length)} viajes`}
          values={{
            airport: filter.airport,
            minNights: filter.minNights,
            maxNights: filter.maxNights,
            when: filter.when,
            maxDaysOff: filter.maxDaysOff === null ? "" : String(filter.maxDaysOff),
            maxPrice: filter.maxPrice === null ? "" : String(filter.maxPrice),
            sameAirport: filter.sameOnly,
            direct: filter.directOnly,
            sort: sortKey === "effective" ? undefined : sortKey,
            dir: dir === -1 ? "-1" : undefined,
          }}
        />

        {selected && (
          <DetailCard
            title={`${selected.out.origin} → ALC → ${selected.ret.destination} · ${selected.nights} noches`}
            meta={
              `Ida ${fmtDep(selected.out.departure, selected.out.dateOnly)} (${selected.out.airline ?? "?"}) · ` +
              `vuelta ${fmtDep(selected.ret.departure, selected.ret.dateOnly)} (${selected.ret.airline ?? "?"}) · ` +
              `total ${fmtEUR(selected.price)}`
            }
            links={bookingLinksForTrip(selected)}
            series={[
              {
                origin: selected.out.origin,
                destination: "ALC",
                departure: selected.out.departure,
                name: "ida",
                color: "--series-1",
              },
              {
                origin: "ALC",
                destination: selected.ret.destination,
                departure: selected.ret.departure,
                name: "vuelta",
                color: "--series-2",
              },
            ]}
            closeHref={hrefWith(params, { sel: null })}
          />
        )}

        <div className="card" id="tableView">
          <div className="tablewrap">
            <table id="tbl">
              <thead>
                <tr>
                  <th className="starcol" />
                  {COLS.map((c) => (
                    <th key={c.k} className={c.num ? "num" : undefined}>
                      <a href={sortHref(c.k)} className="block text-inherit no-underline">
                        {c.t}
                        <span className="arrow">
                          {sortKey === c.k ? (dir === 1 ? "▲" : "▼") : ""}
                        </span>
                      </a>
                    </th>
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
                {pageRows.map((t) => {
                  const key = tripKey(t);
                  const fav = tripFav(t);
                  return (
                    <RowLink
                      key={key}
                      href={hrefWith(params, { sel: key })}
                      selected={selected === t}
                    >
                      <td className="starcol">
                        <StarButton fav={fav} on={favKeys.has(favoriteKey(fav))} />
                      </td>
                      <td>
                        <LegCell origin={t.out.origin} destination="ALC" airline={t.out.airline} stops={t.out.stops} />
                      </td>
                      <td>
                        <WhenCell departure={t.out.departure} dateOnly={t.out.dateOnly} />
                      </td>
                      <td>
                        <LegCell origin="ALC" destination={t.ret.destination} airline={t.ret.airline} stops={t.ret.stops} />
                      </td>
                      <td>
                        <WhenCell departure={t.ret.departure} dateOnly={t.ret.dateOnly} />
                      </td>
                      <td className="num">{t.nights}</td>
                      <td className="num">
                        <DaysOff days={t.daysOff} />
                      </td>
                      <td className="num">
                        {fmtEUR(t.price)}
                        {t.isPackage && <> <span className="badge">paq.</span></>}
                      </td>
                      <td className="num adj">{fmtAdj(t.adjustment)}</td>
                      <td className="num">
                        <span className="eff">{fmtEUR(t.effective)}</span>
                      </td>
                      <td>
                        <Badges label={t.out.label} />
                      </td>
                    </RowLink>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager params={params} page={page} total={trips.length} />
        </div>

        <p className="footnote">
          <b>Coste efectivo</b> = precio + ajuste por conveniencia de cada
          trayecto (finde −{cfg.scoring.weekendBonus} €, viernes tarde −
          {cfg.scoring.fridayEveningBonus} €, horario laboral +
          {cfg.scoring.workHoursPenalty} €, entre semana +
          {cfg.scoring.weekdayPenalty} €, madrugón +{cfg.scoring.earlyPenalty} €).
          Haz clic en una fila para ver la evolución del precio.{" "}
          <a href="/info">Cómo funciona →</a>
        </p>
      </div>
    </>
  );
}

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
