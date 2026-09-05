import { sql } from "drizzle-orm";
import { db } from "@/db";
import { alertHits, alerts, fares, favorites, packageFares } from "@/db/schema";

/**
 * Temporary status page, replaced by "Ida y vuelta" when the real pages land.
 *
 * It earns its place until then by exercising the whole read path in one
 * request — Server Component, Drizzle, Postgres — against the imported
 * history rather than against a fixture.
 */

export const dynamic = "force-dynamic";

const TABLES = [
  { label: "fares", table: fares },
  { label: "package_fares", table: packageFares },
  { label: "alerts", table: alerts },
  { label: "alert_hits", table: alertHits },
  { label: "favorites", table: favorites },
] as const;

export default async function Home() {
  const counts = await Promise.all(
    TABLES.map(async ({ label, table }) => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(table);
      return { label, n: row.n };
    }),
  );

  // `price` is numeric, which the driver returns as a string so that no fare
  // is rounded through a float on the way out. Formatting, not arithmetic.
  const cheapest = await db
    .select({
      origin: fares.origin,
      destination: fares.destination,
      departure: fares.departure,
      airline: fares.airline,
      stops: fares.stops,
      price: fares.price,
    })
    .from(fares)
    .orderBy(fares.price)
    .limit(8);

  return (
    <main className="mx-auto max-w-3xl p-8 font-sans">
      <h1 className="text-2xl font-semibold">Viajes</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Migración en curso. Esta página es provisional: comprueba que la
        historia importada se lee desde Postgres.
      </p>

      <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Filas importadas
      </h2>
      <ul className="grid grid-cols-2 gap-x-8 sm:grid-cols-3">
        {counts.map(({ label, n }) => (
          <li key={label} className="flex justify-between border-b py-1 text-sm">
            <span className="text-neutral-500">{label}</span>
            <span className="tabular-nums font-medium">{n}</span>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Vuelos más baratos registrados
      </h2>
      <table className="w-full text-sm">
        <tbody>
          {cheapest.map((f, i) => (
            <tr key={i} className="border-b">
              <td className="py-1 font-medium">
                {f.origin}→{f.destination}
              </td>
              {/* The wall clock, exactly as stored: no zone conversion. */}
              <td className="py-1 tabular-nums">
                {f.departure.slice(0, 16).replace(" ", " · ")}
              </td>
              <td className="py-1 text-neutral-500">
                {f.airline}
                {f.stops > 0 ? ` · ${f.stops} escala${f.stops > 1 ? "s" : ""}` : ""}
              </td>
              <td className="py-1 text-right tabular-nums font-medium">
                {f.price} €
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
