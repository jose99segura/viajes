"use client";

import { useRouter } from "next/navigation";

/**
 * A table row that navigates on click. A <tr> cannot be an <a>, and the
 * selected row is a query parameter (`sel`), so the click pushes the URL.
 * `scroll: false` keeps the table where it is; the detail card scrolls
 * itself into view.
 */
export function RowLink({
  href,
  selected,
  children,
}: {
  href: string;
  selected: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <tr
      className={selected ? "selected" : undefined}
      onClick={() => router.push(href, { scroll: false })}
    >
      {children}
    </tr>
  );
}
