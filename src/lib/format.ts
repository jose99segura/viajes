import { parseWallClock, weekday } from "./wallclock";

/**
 * Display formatting, in Spanish. Port of the helpers at the top of
 * static/app.js — with one difference: nothing here builds a Date from a
 * departure. The old code did (`new Date(iso)`), which worked only because
 * the browser and the airports shared a time zone. These read the wall
 * clock as stored.
 */

/** Monday first, matching weekday() from wallclock.ts. */
const DAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const MONTHS = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

const eur2 = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const eur0 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("es-ES");

export const fmtEUR = (v: number) => `${eur2.format(v)} €`;
export const fmtEUR0 = (v: number) => `${eur0.format(Math.round(v))} €`;
export const fmtInt = (v: number) => int.format(v);

/** "+60 €" / "−15 €" / "0 €" as the adjustment column shows it. */
export const fmtAdj = (v: number) =>
  `${v > 0 ? "+" : ""}${v.toFixed(0)} €`;

const LABELS_ES: Record<string, string> = {
  weekend: "finde",
  "fri evening": "viernes tarde",
  weekday: "entre semana",
  "work hours": "horario laboral",
  early: "madrugón",
  friday: "viernes",
  ok: "ok",
};

export const labelES = (label: string) =>
  label.split(", ").map((p) => LABELS_ES[p] ?? p).join(" · ");

export function badgeClass(part: string): "good" | "warn" | "" {
  if (part.includes("work hours")) return "warn";
  if (part.includes("weekend") || part.includes("fri evening")) return "good";
  return "";
}

/** Each comma-separated part of a label, with its badge tone. */
export const labelParts = (label: string) =>
  label.split(", ").map((p) => ({ text: LABELS_ES[p] ?? p, tone: badgeClass(p) }));

export const stopsES = (n: number) =>
  !n ? "directo" : n === 1 ? "1 escala" : `${n} escalas`;

/** { day: "sáb 14 nov", time: "18:45" } */
export function whenParts(departure: string): { day: string; time: string } {
  const w = parseWallClock(departure);
  const hh = Math.floor(w.minutes / 60);
  const mm = w.minutes % 60;
  return {
    day: `${DAYS[weekday(w)]} ${w.day} ${MONTHS[w.month - 1]}`,
    time: `${pad(hh)}:${pad(mm)}`,
  };
}

/** "sáb 14 nov 18:45" — or just the day for a date-only (Luxair) leg. */
export function fmtDep(departure: string, dateOnly = false): string {
  const { day, time } = whenParts(departure);
  return dateOnly ? day : `${day} ${time}`;
}

/** "14 nov" for a "YYYY-MM-DD" or a full wall clock. */
export function fmtDay(text: string): string {
  const w = parseWallClock(text);
  return `${w.day} ${MONTHS[w.month - 1]}`;
}

/**
 * "actualizado 6 sep, 15:49" for a capture instant. This IS an instant, so
 * a zone is legitimately needed to show it; the tracker's user lives in
 * CET, so that is the zone, regardless of where the server runs.
 */
const capturedFmt = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Luxembourg",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function fmtCaptured(iso: string | null): string {
  if (!iso) return "";
  // "6 sept, 15:49" → the old UI's "6 sep, 15:49".
  return `actualizado ${capturedFmt.format(new Date(iso)).replace("sept", "sep")}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
