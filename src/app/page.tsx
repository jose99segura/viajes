import { OneWayView } from "@/app/oneway-view";
import { Topbar } from "@/components/shell/Topbar";
import {
  Badges,
  DaysOff,
  GroundCell,
  LegCell,
  SortHeader,
  WhenCell,
} from "@/components/trips/cells";
import { KindField } from "@/components/trips/KindField";
import { GroupToggle } from "@/components/trips/GroupToggle";
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
} from "@/lib/format";
import {
  buildTrips,
  tripKey,
  type Trip,
  type TripFilter,
  type When,
} from "@/lib/trips";
import { groupTrips } from "@/lib/grouping";
import { hrefWith, last, one, type Params } from "@/lib/url";

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
  ground: (t) => t.ground,
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
  { k: "ground", t: "Coche", num: true },
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
  const kind = one(params, "kind") === "oneway" ? "oneway" : "trips";
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

  // One-way is a mode of this page, not a route of its own.
  if (kind === "oneway") {
    return (
      <OneWayView
        params={params}
        airports={airports}
        toolbar={<KindField kind="oneway" />}
      />
    );
  }

  const built = buildTrips(rows, packages, cfg, filter);
  const lastCaptured = built.lastCaptured;
  // A day clicked on the calendar (or an alert's calendar) narrows the list
  // to trips leaving that day. Applied before the cap, unlike the old client
  // filter over the capped list, so a busy day is not cut short.
  const depart = one(params, "depart");
  const all = depart
    ? built.trips.filter((t) => t.out.departure.startsWith(depart))
    : built.trips;
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

  // Grouping is on by default, as the old checkbox was; `group=0` turns
  // it off. It is a view of the rows already computed, never a refetch.
  const grouping = last(params, "group") !== "0";
  const openGroups = new Set(
    Array.isArray(params.open) ? params.open : params.open ? [params.open] : [],
  );
  const rowsToShow = grouping
    ? groupTrips(trips, openGroups)
    : trips.map((trip) => ({ trip, key: "", more: 0, child: false }));

  const pages = Math.max(1, Math.ceil(rowsToShow.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(one(params, "page")) || 1), pages);
  const pageRows = rowsToShow.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
          count={countLabel(rowsToShow.length, trips.length, depart)}
          depart={depart}
          clearDepartHref={depart ? hrefWith(params, { depart: null, page: null, sel: null }) : undefined}
          kindField={<KindField kind="trips" />}
          values={{
            airport: filter.airport,
            minNights: filter.minNights,
            maxNights: filter.maxNights,
            when: filter.when,
            maxDaysOff: filter.maxDaysOff === null ? "" : String(filter.maxDaysOff),
            maxPrice: filter.maxPrice === null ? "" : String(filter.maxPrice),
            sameAirport: filter.sameOnly,
            direct: filter.directOnly,
            group: grouping,
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
              costBreakdown(selected)
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
                {pageRows.map(({ trip: t, key: gKey, more, child }) => {
                  const key = tripKey(t);
                  const fav = tripFav(t);
                  return (
                    <RowLink
                      key={key}
                      href={hrefWith(params, { sel: key })}
                      selected={selected === t}
                      className={child ? "child" : undefined}
                    >
                      <td className="starcol">
                        <StarButton fav={fav} on={favKeys.has(favoriteKey(fav))} />
                      </td>
                      <td>
                        <LegCell origin={t.out.origin} destination="ALC" airline={t.out.airline} stops={t.out.stops} />
                        {more > 0 && (
                          <GroupToggle
                            href={toggleGroupHref(params, openGroups, gKey)}
                            open={openGroups.has(gKey)}
                            more={more}
                          />
                        )}
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
                      {/* The euros those days cost ride in the tooltip: the
                          table is wide enough, and the detail card spells it out. */}
                      <td
                        className="num"
                        title={t.holiday ? `${t.holiday.toFixed(0)} € de vacaciones` : undefined}
                      >
                        <DaysOff days={t.daysOff} />
                      </td>
                      <td className="num">
                        {fmtEUR(t.price)}
                        {t.isPackage && <> <span className="badge">paq.</span></>}
                      </td>
                      <td className="num adj">{fmtAdj(t.adjustment)}</td>
                      <td className="num adj" title={t.groundLabel}>
                        <GroundCell ground={t.ground} />
                      </td>
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
          <b>Coste efectivo</b> = billete + ajuste por conveniencia de cada
          trayecto (finde −{cfg.scoring.weekendBonus} €, viernes tarde −
          {cfg.scoring.fridayEveningBonus} €, horario laboral +
          {cfg.scoring.workHoursPenalty} €, entre semana +
          {cfg.scoring.weekdayPenalty} €, madrugón +{cfg.scoring.earlyPenalty} €,
          llegar a casa de noche +{cfg.scoring.lateArrivalPenalty} €) + el coche
          hasta el aeropuerto (gasolina, peajes, tus horas al volante y el
          parking) + {cfg.scoring.dayOffCost} € por cada día de vacaciones que
          gasta. Haz clic en una fila para ver la evolución del precio.{" "}
          <a href="/info">Cómo funciona →</a>
        </p>
      </div>
    </>
  );
}

/**
 * Ticket, convenience, car and holiday spelled out, so the ranking never
 * looks arbitrary next to a cheaper fare that ranks below it.
 */
function costBreakdown(t: Trip): string {
  const bits = [`${fmtEUR(t.price)} billete`];
  if (t.adjustment) bits.push(`${fmtAdj(t.adjustment)} ajuste`);
  if (t.ground)
    bits.push(`+${t.ground.toFixed(0)} € coche${t.groundLabel ? ` (${t.groundLabel})` : ""}`);
  if (t.holiday) bits.push(`+${t.holiday.toFixed(0)} € ${t.holidayLabel}`);
  return `${bits.join(" ")} = ${fmtEUR(t.effective)} efectivo`;
}

/**
 * How many rows are shown, and out of how many when grouping hides some —
 * otherwise a folded list looks like the filters lost results.
 */
function countLabel(shown: number, total: number, depart?: string): string {
  const noun = depart ? `viajes saliendo el ${depart}` : "viajes";
  return shown < total
    ? `${fmtInt(shown)} de ${fmtInt(total)} ${noun}`
    : `${fmtInt(total)} ${noun}`;
}

/** The URL with one group folded or unfolded, keeping every other one. */
function toggleGroupHref(params: Params, open: Set<string>, key: string): string {
  const next = new Set(open);
  if (!next.delete(key)) next.add(key);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "open") continue;
    const s = Array.isArray(v) ? v[0] : v;
    if (s !== undefined && s !== "") q.set(k, s);
  }
  for (const k of next) q.append("open", k);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}
