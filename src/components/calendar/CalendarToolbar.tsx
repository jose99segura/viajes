"use client";

import { useFilterForm } from "@/components/trips/use-filter-form";

/** Airport and direction for the calendar. Auto-submitting GET form. */
export function CalendarToolbar({
  airport,
  dir,
  month,
  airports,
}: {
  airport: string;
  dir: "outbound" | "inbound";
  month?: string;
  airports: string[];
}) {
  const { form, submit } = useFilterForm("/calendario");

  return (
    <form ref={form} method="get" action="/calendario" className="toolbar">
      {month && <input type="hidden" name="month" value={month} />}
      <label className="field">
        <span>Aeropuerto</span>
        <select name="airport" defaultValue={airport} onChange={submit}>
          <option value="">Todos</option>
          {airports.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Dirección</span>
        <select name="dir" defaultValue={dir} onChange={submit}>
          <option value="outbound">Ida hacia ALC</option>
          <option value="inbound">Vuelta desde ALC</option>
        </select>
      </label>
    </form>
  );
}
