"use client";

import { useEffect } from "react";
import { markAlertsSeen } from "@/app/alertas/actions";

/**
 * Opening the alerts page is what marks its new matches as read — the same
 * behaviour the old view had. Done from the client after render, so the
 * page request itself stays a read: the matches are still shown as new on
 * this visit, and the sidebar count clears on the next navigation.
 */
export function MarkSeen() {
  useEffect(() => {
    markAlertsSeen();
  }, []);
  return null;
}
