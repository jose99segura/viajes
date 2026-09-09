import Link from "next/link";
import { AlertButtons } from "@/components/alerts/AlertButtons";
import { AlertForm } from "@/components/alerts/AlertForm";
import { AlertRowLink } from "@/components/alerts/AlertRowLink";
import { MarkSeen } from "@/components/alerts/MarkSeen";
import { MonthGrid } from "@/components/calendar/MonthGrid";
import { Topbar } from "@/components/shell/Topbar";
import {
  latestPackages,
  latestSnapshot,
  listAlerts,
  unseenKeysByAlert,
  type AlertRow,
} from "@/db/queries";
import { evaluateAlerts, type AlertEntry, type AlertMatch } from "@/lib/alerts";
import { bookingLinksForTrip } from "@/lib/booking";
import { monthLabel } from "@/lib/calendar";
import { loadConfig } from "@/lib/config";
import { fmtEUR, whenParts } from "@/lib/format";
import { hrefWith, one, type Params } from "@/lib/url";

/**
 * "Alertas" — saved rules, each with its current matches as a month-grouped
 * list or a mini calendar. Every fetch re-checks the rules and records what
 * is new; this page shows the read side and, on open, marks it seen.
 *
 * View state lives in the URL: `edit=new|<id>` opens the form, `cal=<id>`
 * (repeatable) shows a rule's calendar instead of its list.
 */

export const metadata = { title: "Alertas" };

function rulesText(a: AlertRow): string {
  const bits: string[] = [];
  bits.push(a.airport ? `desde ${a.airport}` : "cualquier aeropuerto");
  if (a.maxPrice != null) bits.push(`≤ ${Math.round(Number(a.maxPrice))} €`);
  bits.push(
    a.maxDaysOff == null
      ? "días libres: los que sean"
      : a.maxDaysOff === 0
        ? "sin días libres"
        : `≤ ${a.maxDaysOff} día(s) libre(s)`,
  );
  bits.push(`${a.minNights}–${a.maxNights} noches`);
  if (a.directOnly) bits.push("solo directos");
  return bits.join(" · ");
}

/** "sáb 14 nov 18:45", or just the day for a Luxair leg. */
function legWhen(leg: AlertMatch["out"]): string {
  const { day, time } = whenParts(leg.departure);
  return leg.dateOnly ? day : `${day} ${time}`;
}

/**
 * Chronological month buckets, matches within each in date order — the
 * evaluator sorts by price, which is not the order you want once you are
 * scanning a whole month at a glance.
 */
function groupByMonth(matches: AlertMatch[]): Array<[string, AlertMatch[]]> {
  const groups = new Map<string, AlertMatch[]>();
  for (const m of matches) {
    const key = m.out.departure.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, list] of ordered) {
    list.sort((a, b) => a.out.departure.localeCompare(b.out.departure));
  }
  return ordered;
}

/** Where a match links: the trips list narrowed around it. */
function matchHref(m: AlertMatch): string {
  return hrefWith(
    {},
    {
      airport: m.out.origin === "ALC" ? null : m.out.origin,
      min_nights: m.nights,
      max_nights: m.nights,
    },
    "/",
  );
}

/** Where a calendar day links: the trips list under this rule, that day. */
function dayHref(a: AlertRow, iso: string): string {
  return hrefWith(
    {},
    {
      airport: a.airport || null,
      min_nights: a.minNights,
      max_nights: a.maxNights,
      max_days_off: a.maxDaysOff,
      max_price: a.maxPrice == null ? null : Math.round(Number(a.maxPrice)),
      direct: a.directOnly ? "1" : null,
      depart: iso,
    },
    "/",
  );
}

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const cfg = loadConfig();
  const [alertsList, unseen, rows, packages] = await Promise.all([
    listAlerts(),
    unseenKeysByAlert(),
    latestSnapshot(),
    latestPackages(),
  ]);
  const entries = evaluateAlerts(alertsList, unseen, rows, packages, cfg);
  const anyUnseen = entries.some((e) => e.unseen > 0);

  const edit = one(params, "edit");
  const calIds = new Set(
    (Array.isArray(params.cal) ? params.cal : params.cal ? [params.cal] : []).map(Number),
  );
  const calHref = (id: number, on: boolean) => {
    const next = new Set(calIds);
    if (on) next.add(id);
    else next.delete(id);
    const q = new URLSearchParams();
    for (const c of next) q.append("cal", String(c));
    if (edit) q.set("edit", edit);
    const s = q.toString();
    return `/alertas${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <Topbar title="Alertas" />
      <div className="content">
        {anyUnseen && <MarkSeen />}

        <div className="alerts-bar">
          <p>
            Cada <code>fetch</code> comprueba estas reglas y marca lo que ha
            aparecido nuevo.
          </p>
          <Link
            href={edit === "new" ? hrefWith(params, { edit: null }) : hrefWith(params, { edit: "new" })}
            className="icon-btn primary"
          >
            + Nueva alerta
          </Link>
        </div>

        {edit === "new" && (
          <div className="alert">
            <AlertForm alert={null} cancelHref={hrefWith(params, { edit: null })} />
          </div>
        )}

        {!entries.length && <div className="alert-empty">No hay alertas todavía.</div>}

        {entries.map((entry) => (
          <AlertCard
            key={entry.alert.id}
            entry={entry}
            editing={edit === String(entry.alert.id)}
            editHref={
              edit === String(entry.alert.id)
                ? hrefWith(params, { edit: null })
                : hrefWith(params, { edit: entry.alert.id })
            }
            cancelHref={hrefWith(params, { edit: null })}
            calendar={calIds.has(entry.alert.id)}
            listHref={calHref(entry.alert.id, false)}
            calendarHref={calHref(entry.alert.id, true)}
          />
        ))}
      </div>
    </>
  );
}

function AlertCard({
  entry,
  editing,
  editHref,
  cancelHref,
  calendar,
  listHref,
  calendarHref,
}: {
  entry: AlertEntry;
  editing: boolean;
  editHref: string;
  cancelHref: string;
  calendar: boolean;
  listHref: string;
  calendarHref: string;
}) {
  const a = entry.alert;
  const nNew = entry.matches.filter((m) => m.isNew).length;
  return (
    <div className={`alert${a.enabled ? "" : " off"}`}>
      <div className="alert-head">
        <div>
          <h3>{a.name}</h3>
          <div className="rules">{rulesText(a)}</div>
        </div>
        <div className="grow" />
        {nNew > 0 && (
          <span className="pill new">
            {nNew} nueva{nNew === 1 ? "" : "s"}
          </span>
        )}
        <span className={`pill${entry.total ? " hit" : ""}`}>
          {entry.total} coincidencia{entry.total === 1 ? "" : "s"}
        </span>
        <div className="view-toggle">
          <Link href={listHref} className={calendar ? undefined : "active"} role="button">
            ☰ Lista
          </Link>
          <Link href={calendarHref} className={calendar ? "active" : undefined} role="button">
            ▦ Calendario
          </Link>
        </div>
        <AlertButtons id={a.id} enabled={a.enabled} editHref={editHref} />
      </div>

      {editing && <AlertForm alert={a} cancelHref={cancelHref} />}

      <div className="alert-rows">
        {!a.enabled ? (
          <div className="alert-empty">Desactivada.</div>
        ) : !entry.matches.length ? (
          <div className="alert-empty">
            Nada por ahora. Se revisa en cada <code>fetch</code>.
          </div>
        ) : calendar ? (
          <AlertCalendar alert={a} matches={entry.matches} />
        ) : (
          groupByMonth(entry.matches).map(([key, list]) => {
            const [y, m] = key.split("-").map(Number);
            return (
              <div key={key}>
                <div className="alert-month">
                  {monthLabel(y, m)} <span className="n">· {list.length}</span>
                </div>
                {list.map((m) => (
                  <AlertRowView key={m.key} m={m} />
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function AlertRowView({ m }: { m: AlertMatch }) {
  return (
    <AlertRowLink href={matchHref(m)} isNew={m.isNew} links={bookingLinksForTrip(m)}>
      {m.isNew ? <span className="newdot" title="Nuevo" /> : <span style={{ width: 6 }} />}
      <span className="route">
        {m.out.origin} → ALC → {m.ret.destination}
      </span>
      <span className="dates">
        {legWhen(m.out)} → {legWhen(m.ret)} · {m.nights}n · {m.out.airline}
        {m.isPackage ? " (paq.)" : ""}
      </span>
      {m.daysOff === 0 ? (
        <span className="tag free">sin días libres</span>
      ) : (
        <span className="tag">
          {m.daysOff} día{m.daysOff === 1 ? "" : "s"} libre{m.daysOff === 1 ? "" : "s"}
        </span>
      )}
      {/* Effective leads, since that is what the list is ranked by;
          the ticket underneath keeps it honest. */}
      <span className="price" title={costBreakdown(m)}>
        {fmtEUR(m.effective)}
        <span
          style={{
            display: "block",
            color: "var(--muted)",
            fontSize: 11,
            fontWeight: 500,
          }}
        >
          {fmtEUR(m.price)} billete
        </span>
      </span>
    </AlertRowLink>
  );
}

/** The rule's matches as mini month grids; new-match days are outlined. */
function AlertCalendar({ alert, matches }: { alert: AlertRow; matches: AlertMatch[] }) {
  // Effective cost, as the trip list and the main calendar rank.
  const byDay: Record<string, number> = {};
  const titles: Record<string, string> = {};
  const newDays = new Set<string>();
  for (const m of matches) {
    const day = m.out.departure.slice(0, 10);
    if (!(day in byDay) || m.effective < byDay[day]) {
      byDay[day] = m.effective;
      titles[day] =
        `${day} · ${m.out.origin} → ALC → ${m.ret.destination} · ` +
        `${fmtEUR(m.price)} billete → ${fmtEUR(m.effective)} efectivo`;
    }
    if (m.isNew) newDays.add(day);
  }
  const days = Object.keys(byDay).sort();
  if (!days.length) return <div className="alert-empty">Nada por ahora.</div>;
  const prices = Object.values(byDay);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);

  const months: Array<[number, number]> = [];
  let [y, m] = [Number(days[0].slice(0, 4)), Number(days[0].slice(5, 7))];
  const last = days[days.length - 1].slice(0, 7);
  while (`${y}-${String(m).padStart(2, "0")}` <= last) {
    months.push([y, m]);
    if (m === 12) {
      y += 1;
      m = 1;
    } else m += 1;
  }

  return (
    <div className="alert-cal">
      {months.map(([yy, mm]) => (
        <MonthGrid
          key={`${yy}-${mm}`}
          year={yy}
          month={mm}
          prices={byDay}
          lo={lo}
          hi={hi}
          hrefFor={(iso) => dayHref(alert, iso)}
          outlined={newDays}
          titles={titles}
        />
      ))}
    </div>
  );
}

/** Ticket, convenience, car and holiday, for the row's tooltip. */
function costBreakdown(m: AlertMatch): string {
  const bits = [`${fmtEUR(m.price)} billete`];
  if (m.adjustment) {
    bits.push(`${m.adjustment > 0 ? "+" : "−"}${Math.abs(m.adjustment).toFixed(0)} € ajuste`);
  }
  if (m.ground) bits.push(`+${m.ground.toFixed(0)} € coche`);
  if (m.holiday) bits.push(`+${m.holiday.toFixed(0)} € ${m.holidayLabel}`);
  return `${bits.join(" ")} = ${fmtEUR(m.effective)} efectivo`;
}
