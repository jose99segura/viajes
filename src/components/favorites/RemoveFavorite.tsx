"use client";

import { useTransition } from "react";
import { toggleFavorite } from "@/app/actions";
import type { FavoriteInput } from "@/lib/favorites";

/** The ✕ on a favourite card. Same action as the star; here it only removes. */
export function RemoveFavorite({ fav }: { fav: FavoriteInput }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="rm"
      title="Quitar"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await toggleFavorite(fav);
        })
      }
    >
      ✕
    </button>
  );
}
