"use client";

import { useRef } from "react";

/** The filter bar for "Solo ida". Same GET-form pattern as TripsToolbar. */
export function FlightsToolbar({
  values,
  airports,
  count,
}: {
  values: {
    airport: string;
    when: string;
    maxPrice: string;
    source: string;
    direct: boolean;
    sort?: string;
    dir?: string;
  };
  airports: string[];
  count: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();

  return (
    <form ref={form} method="get" action="/solo-ida" className="toolbar">
      {values.sort && <input type="hidden" name="sort" value={values.sort} />}
      {values.dir && <input type="hidden" name="dir" value={values.dir} />}

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

      <label className="field">
        <span>Fuente</span>
        <select name="source" defaultValue={values.source} onChange={submit}>
          <option value="">Todas</option>
          <option value="ryanair">Ryanair</option>
          <option value="google">Google Flights</option>
        </select>
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
      <div className="count">{count}</div>
    </form>
  );
}
