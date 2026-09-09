/**
 * Query-string helpers for pages whose whole state lives in the URL —
 * filters, sort, page, selected row. A link that changes one thing must
 * carry everything else along, or a click on "page 2" would drop the
 * filters.
 */

export type Params = Record<string, string | string[] | undefined>;

/** First value of a param, or undefined. */
export function one(params: Params, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Last value of a param. Used for a checkbox that defaults to on: the form
 * sends a hidden "0" followed by the checkbox's "1", and the later value
 * is the one the user actually set.
 */
export function last(params: Params, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[v.length - 1] : v;
}

/**
 * Same params with `patch` applied; a null/undefined/"" value removes the
 * key. Returns "?a=1&b=2" — or a bare "?" when nothing is left, which the
 * browser resolves to the current path with an empty query. Never "": an
 * empty href points at the current URL, query included, so a "close" or
 * "page 1" link that cleared the last parameter would go nowhere.
 */
export function hrefWith(
  params: Params,
  patch: Record<string, string | number | null | undefined>,
  pathname = "",
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s !== undefined && s !== "") q.set(k, s);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") q.delete(k);
    else q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${pathname}?${s}` : pathname || "?";
}
