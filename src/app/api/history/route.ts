import { priceHistory } from "@/db/queries";

/**
 * Price history for one route on one day, for the chart. The only real API
 * the pages need: everything else is server-rendered, but the history is
 * fetched when a row is clicked, not with the page.
 *
 * Same shape as the Flask /api/history, so the chart code ported as-is.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const origin = q.get("origin") ?? "";
  const destination = q.get("destination") ?? "";
  const day = q.get("day") ?? "";
  if (!origin || !destination || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return Response.json(
      { error: "origin, destination and day (YYYY-MM-DD) are required" },
      { status: 400 },
    );
  }
  const rows = await priceHistory(origin, destination, day);
  return Response.json({
    points: rows.map((r) => ({
      captured_at: r.capturedAt,
      departure: r.departure,
      airline: r.airline,
      price: r.price,
      source: r.source,
    })),
  });
}
