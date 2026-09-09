"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

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
 * A soft navigation fixes all three at once: `scroll: false` keeps your
 * place in the list, the client component is preserved so focus stays in
 * the field you are typing in, and empty values are dropped so the URL
 * stays readable and shareable.
 *
 * Empty means absent for every filter here — `when=""` is "todos", the same
 * as no `when` at all — so dropping them changes no behaviour. The one
 * exception is `group`, whose hidden "0" is a real value the page reads;
 * `append` keeps both entries in order so the LAST-wins rule still holds.
 */
export function useFilterForm(action: string) {
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();

  // Where the list was when the filter changed. `scroll: false` on its own
  // did not hold it — measured: 400 before, 0 after, with the page still
  // 1839px tall — so the position is put back by hand once the new rows
  // have rendered.
  const restoreTo = useRef<number | null>(null);

  useEffect(() => {
    const y = restoreTo.current;
    if (y === null) return;
    restoreTo.current = null;
    // Two frames, not zero: the router resets the scroll after this effect
    // runs, so restoring synchronously is overwritten and the page still
    // lands at the top. Waiting until after the next paint puts it back
    // once the navigation has finished moving it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // Clamp: a narrower result set can be shorter than the old position.
        const max = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo({ top: Math.min(y, Math.max(0, max)), behavior: "instant" as ScrollBehavior });
      }),
    );
  });

  const submit = () => {
    const el = form.current;
    if (!el) return;
    restoreTo.current = window.scrollY;
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
