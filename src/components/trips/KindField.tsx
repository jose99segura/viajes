"use client";

/**
 * "Tipo": round trips or one ways, within the same search page. It was a
 * nav entry of its own; as a filter, switching keeps the airport, the price
 * cap and everything else in the bar.
 *
 * A plain select inside the surrounding GET form — changing it submits, so
 * `kind` lands in the URL like every other filter.
 */
export function KindField({ kind }: { kind: "trips" | "oneway" }) {
  return (
    <label className="field" id="lKind">
      <span>Tipo</span>
      <select
        name="kind"
        defaultValue={kind}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <option value="trips">Ida y vuelta</option>
        <option value="oneway">Solo ida</option>
      </select>
    </label>
  );
}
