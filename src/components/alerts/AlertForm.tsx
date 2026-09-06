import Link from "next/link";
import { saveAlert } from "@/app/alertas/actions";
import type { AlertRow } from "@/db/queries";

/**
 * New / edit form for one alert rule. A plain form posting to a Server
 * Action; "Cancelar" is a link back to the list without `edit`.
 */
export function AlertForm({
  alert,
  cancelHref,
}: {
  alert: AlertRow | null;
  cancelHref: string;
}) {
  return (
    <form action={saveAlert} className="alert-form">
      {alert && <input type="hidden" name="id" value={alert.id} />}
      <label className="field">
        <span>Nombre</span>
        <input
          type="text"
          name="name"
          defaultValue={alert?.name ?? ""}
          placeholder="Finde barato"
        />
      </label>
      <label className="field">
        <span>Aeropuerto</span>
        <select name="airport" defaultValue={alert?.airport ?? ""}>
          <option value="">Cualquiera</option>
          {["LUX", "SCN", "HHN"].map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Precio máx (€)</span>
        <input
          type="number"
          className="narrow"
          name="max_price"
          min={0}
          step={10}
          style={{ width: 80 }}
          defaultValue={alert?.maxPrice != null ? Math.round(Number(alert.maxPrice)) : ""}
        />
      </label>
      <label className="field">
        <span>Días libres máx</span>
        <select
          name="max_days_off"
          defaultValue={alert?.maxDaysOff != null ? String(alert.maxDaysOff) : ""}
        >
          <option value="">Los que sean</option>
          {[0, 1, 2, 3].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "Ninguno" : n}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Noches</span>
        <span className="nights">
          <input
            type="number"
            className="narrow"
            name="min_nights"
            min={0}
            defaultValue={alert?.minNights ?? 1}
          />
          <span>–</span>
          <input
            type="number"
            className="narrow"
            name="max_nights"
            min={0}
            defaultValue={alert?.maxNights ?? 4}
          />
        </span>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          name="direct_only"
          value="1"
          defaultChecked={alert?.directOnly ?? false}
        />{" "}
        solo directos
      </label>
      <div className="actions">
        <Link href={cancelHref} role="button" className="inline-block">
          Cancelar
        </Link>
        <button type="submit" className="save">
          Guardar
        </button>
      </div>
    </form>
  );
}
