"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the chat panel is open. The toggle button lives in each page's
 * topbar and the panel in the root layout; this is the smallest thing that
 * lets them share one boolean without a context provider around the app.
 */

let open = false;
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setChatOpen(next: boolean) {
  open = next;
  for (const fn of listeners) fn();
}

export function useChatOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}
