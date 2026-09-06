"use client";

import { useOptimistic, useTransition } from "react";
import { toggleFavorite } from "@/app/actions";
import type { FavoriteInput } from "@/lib/favorites";

/**
 * The ☆/★ in the first column. Optimistic so the star flips on click and
 * does not wait for the round trip; the server action then revalidates the
 * page and the sidebar count.
 */
export function StarButton({ fav, on }: { fav: FavoriteInput; on: boolean }) {
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(on);

  return (
    <button
      type="button"
      className={`star${shown ? " on" : ""}`}
      title={shown ? "Quitar de favoritos" : "Guardar en favoritos"}
      disabled={pending}
      onClick={(e) => {
        // The row itself navigates to the detail; the star must not.
        e.stopPropagation();
        startTransition(async () => {
          setShown(!shown);
          await toggleFavorite(fav);
        });
      }}
    >
      {shown ? "★" : "☆"}
    </button>
  );
}
