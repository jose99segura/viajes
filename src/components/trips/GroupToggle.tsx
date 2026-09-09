"use client";

import { useRouter } from "next/navigation";

/**
 * The "+3" next to a row that stands for a whole group. Clicking it folds
 * or unfolds the group without selecting the row, so it has to stop the
 * click from reaching the <tr> underneath.
 */
export function GroupToggle({
  href,
  open,
  more,
}: {
  href: string;
  open: boolean;
  more: number;
}) {
  const router = useRouter();
  return (
    <span
      className="more"
      role="button"
      title={`Otras ${more} combinaciones parecidas esa semana`}
      onClick={(e) => {
        e.stopPropagation();
        router.push(href, { scroll: false });
      }}
    >
      {open ? "−" : "+"}
      {more}
    </span>
  );
}
