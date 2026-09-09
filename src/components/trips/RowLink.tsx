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
  className,
  children,
}: {
  href: string;
  selected: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <tr
      className={[className, selected ? "selected" : ""].filter(Boolean).join(" ") || undefined}
      onClick={() => router.push(href, { scroll: false })}
    >
      {children}
    </tr>
  );
}
