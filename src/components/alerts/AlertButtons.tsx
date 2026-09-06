"use client";

import Link from "next/link";
import { useTransition } from "react";
import { deleteAlert, setAlertEnabled } from "@/app/alertas/actions";

/** The ◉ / ✎ / ✕ trio in an alert's header. */
export function AlertButtons({
  id,
  enabled,
  editHref,
}: {
  id: number;
  enabled: boolean;
  editHref: string;
}) {
  const [pending, start] = useTransition();
  return (
    <>
      <button
        type="button"
        title={enabled ? "Desactivar" : "Activar"}
        disabled={pending}
        onClick={() => start(() => setAlertEnabled(id, !enabled))}
      >
        {enabled ? "◉" : "○"}
      </button>
      <Link href={editHref} title="Editar" role="button">
        ✎
      </Link>
      <button
        type="button"
        title="Borrar"
        disabled={pending}
        onClick={() => start(() => deleteAlert(id))}
      >
        ✕
      </button>
    </>
  );
}
