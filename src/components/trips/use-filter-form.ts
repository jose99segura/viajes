"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";

/**
 * Shared behaviour for the filter bars.
 *
 * They used to be plain GET forms calling `requestSubmit()` on every change,
 * which meant a **full page navigation per field**. Measured on the live
 * site: setting one date threw the page back to scroll 0 from 600, moved
 * focus to <body>, and produced
 *
 *   ?kind=trips&from=2026-11-01&to=&airport=&min_nights=1&max_nights=14
 *    &when=&max_days_off=&max_price=&group=0&group=1
 *
 * So picking a date *range* cost two of those, and you could not tab from
 * one field to the next because focus was gone before you got there.
 *
 * A soft navigation fixes two of those three: the client component is
 * preserved so focus stays in the field you are typing in, and empty values
 * are dropped so the URL stays readable and shareable.
 *
 * It does NOT keep your scroll position, and `scroll: false` is passed but
 * does not hold it either — measured twice in production, 400 before and 0
 * after, once restoring inside the effect and once deferred two frames past
 * the router's own reset. Both were removed rather than left in looking
 * like they worked. Changing a filter therefore returns you to the top,
 * which is at least defensible: the result set is a different one. If it
 * ever needs fixing properly, the place to look is why Next moves the
 * scroll on a same-route search-param change despite the option.
 *
 * Empty means absent for every filter here — `when=""` is "todos", the same
 * as no `when` at all — so dropping them changes no behaviour. The one
 * exception is `group`, whose hidden "0" is a real value the page reads;
 * `append` keeps both entries in order so the LAST-wins rule still holds.
 */
export function useFilterForm(action: string) {
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();

  const submit = () => {
    const el = form.current;
    if (!el) return;
    const query = new URLSearchParams();
    for (const [key, value] of new FormData(el).entries()) {
      const text = String(value);
      if (text === "") continue;
      query.append(key, text);
    }
    const search = query.toString();
    router.replace(search ? `${action}?${search}` : action, { scroll: false });
  };

  return { form, submit };
}
