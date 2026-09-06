"use client";

import { useRouter } from "next/navigation";
import type { BookingLink } from "@/lib/booking";

/**
 * One alert match: the whole row navigates to the trips list, while the
 * booking links inside open the airline instead. A row cannot be an <a>
 * with <a>s inside it, so the row is a div with a click handler, as the
 * old alertRow() was.
 */
export function AlertRowLink({
  href,
  isNew,
  links,
  children,
}: {
  href: string;
  isNew: boolean;
  links: BookingLink[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <div
      className={`alert-row${isNew ? " is-new" : ""}`}
      onClick={() => router.push(href)}
    >
      {children}
      {links.map((l) => (
        <a
          key={l.url}
          className={`book-link small${l.muted ? " muted" : ""}`}
          href={l.url}
          target="_blank"
          rel="noopener"
          title={l.title}
          onClick={(e) => e.stopPropagation()}
        >
          {l.label} ↗
        </a>
      ))}
    </div>
  );
}
