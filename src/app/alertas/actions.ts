"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { alertHits, alerts } from "@/db/schema";

/**
 * Alert rules CRUD, and marking matches as seen. Port of save_alert /
 * delete_alert / mark_alert_seen in db.py, with the same coercions: an
 * empty field means "no limit", names fall back to "Alerta".
 */

function num(v: FormDataEntryValue | null): number | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" || Number.isNaN(Number(s)) ? null : Number(s);
}

/** Create (no id) or update. Redirects back to the list. */
export async function saveAlert(formData: FormData) {
  const idRaw = num(formData.get("id"));
  const values = {
    name: (String(formData.get("name") ?? "").trim() || "Alerta"),
    airport: String(formData.get("airport") ?? "").toUpperCase() || null,
    maxPrice: num(formData.get("max_price"))?.toFixed(2) ?? null,
    maxDaysOff: num(formData.get("max_days_off")),
    minNights: num(formData.get("min_nights")) ?? 1,
    maxNights: num(formData.get("max_nights")) ?? 14,
    directOnly: formData.get("direct_only") === "1",
  };

  if (idRaw === null) {
    await db.insert(alerts).values({ ...values, createdAt: new Date(), enabled: true });
  } else {
    await db.update(alerts).set(values).where(eq(alerts.id, idRaw));
  }
  revalidatePath("/", "layout");
  redirect("/alertas");
}

export async function setAlertEnabled(id: number, enabled: boolean) {
  await db.update(alerts).set({ enabled }).where(eq(alerts.id, id));
  revalidatePath("/", "layout");
}

export async function deleteAlert(id: number) {
  // alert_hits cascades on the foreign key; explicit anyway, as db.py does.
  await db.delete(alertHits).where(eq(alertHits.alertId, id));
  await db.delete(alerts).where(eq(alerts.id, id));
  revalidatePath("/", "layout");
}

/** Opening the alerts page is what marks its new matches as read. */
export async function markAlertsSeen() {
  await db.update(alertHits).set({ seen: true }).where(eq(alertHits.seen, false));
  revalidatePath("/", "layout");
}
