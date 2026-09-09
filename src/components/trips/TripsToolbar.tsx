"use client";

import { useRef } from "react";

/**
 * The filter bar for "Ida y vuelta". A plain GET form: every filter is a
 * query parameter with the same name the Flask /api/trips accepted, so the
 * URL is the state and a reload, a bookmark or the back button all keep it.
 * Any change submits, as the old toolbar re-fetched on change.
 *
 * Changing a filter drops `page` and `sel` (they belong to the previous
 * result set) but keeps the sort.
 */

export interface ToolbarValues {
  airport: string;
  minNights: number;
  maxNights: number;
  when: string;
  maxDaysOff: string;
  maxPrice: string;
  sameAirport: boolean;
  direct: boolean;
  sort?: string;
  dir?: string;
}

export function TripsToolbar({
  values,
  airports,
  count,
  depart,
  clearDepartHref,
  kindField,
}: {
  values: ToolbarValues;
  airports: string[];
  count: string;
  /** A departure day the calendar narrowed the list to, if any. */
  depart?: string;
  clearDepartHref?: string;
  /** The shared "Tipo" select that switches to the one-way view. */
  kindField?: React.ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();

  return (
    <form ref={form} method="get" action="/" className="toolbar" id="toolbar">
      {values.sort && <input type="hidden" name="sort" value={values.sort} />}
      {values.dir && <input type="hidden" name="dir" value={values.dir} />}
      {depart && <input type="hidden" name="depart" value={depart} />}

      {kindField}

      <label className="field">
        <span>Aeropuerto</span>
        <select name="airport" defaultValue={values.airport} onChange={submit}>
          <option value="">Todos</option>
          {airports.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Noches</span>
        <span className="nights">
          <input
            name="min_nights"
            type="number"
            className="narrow"
            min={0}
            defaultValue={values.minNights}
            onChange={submit}
          />
          <span>–</span>
          <input
            name="max_nights"
            type="number"
            className="narrow"
            min={0}
            defaultValue={values.maxNights}
            onChange={submit}
          />
        </span>
      </label>

      <label className="field">
        <span>Cuándo</span>
        <select name="when" defaultValue={values.when} onChange={submit}>
          <option value="">Todos</option>
          <option value="convenient">Finde + viernes tarde</option>
          <option value="weekend">Solo finde</option>
          <option value="fri">Viernes tarde</option>
          <option value="weekday">Entre semana</option>
        </select>
      </label>

      <label className="field">
        <span>Días libres</span>
        <select
          name="max_days_off"
          defaultValue={values.maxDaysOff}
          onChange={submit}
        >
          <option value="">Los que sean</option>
          <option value="0">Ninguno (finde puro)</option>
          <option value="1">Máx. 1 (vie o lun)</option>
          <option value="2">Máx. 2</option>
          <option value="3">Máx. 3</option>
        </select>
      </label>

      <label className="field">
        <span>Precio máx</span>
        <input
          name="max_price"
          type="number"
          min={0}
          step={10}
          placeholder="sin límite"
          defaultValue={values.maxPrice}
          onChange={submit}
        />
      </label>

      <label className="toggle">
        <input
          name="same_airport"
          type="checkbox"
          value="1"
          defaultChecked={values.sameAirport}
          onChange={submit}
        />{" "}
        mismo aeropuerto
      </label>
      <label className="toggle">
        <input
          name="direct"
          type="checkbox"
          value="1"
          defaultChecked={values.direct}
          onChange={submit}
        />{" "}
        solo directos
      </label>

      <div className="grow" />
      {depart && clearDepartHref && (
        <a href={clearDepartHref} className="book-link small muted" title="Quitar el día">
          {depart} ✕
        </a>
      )}
      <div className="count">{count}</div>
    </form>
  );
}
