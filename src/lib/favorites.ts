import { canonical } from "./wallclock";

/**
 * A favourite's identity: the column tuple, joined exactly as
 * favorite_key() in db.py joins it, so a trip saved from the Flask UI and
 * one saved here are the same favourite. Departures are canonicalised to
 * the "T" form first — the database renders them with a space.
 *
 * Plain module, not a Server Action file: page code compares keys while
 * rendering, and "use server" modules may only export async functions.
 */

export interface FavoriteInput {
  /** 'trip' | 'flight' | 'package' */
  kind: string;
  outOrigin: string;
  outDestination: string;
  outDeparture: string;
  retOrigin?: string | null;
  retDestination?: string | null;
  retDeparture?: string | null;
  priceAtSave?: number | null;
}

export function favoriteKey(f: FavoriteInput): string {
  return [
    f.kind,
    f.outOrigin,
    f.outDestination,
    canonical(f.outDeparture),
    f.retOrigin ?? "",
    f.retDestination ?? "",
    f.retDeparture ? canonical(f.retDeparture) : "",
  ].join("|");
}
