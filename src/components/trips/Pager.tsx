import Link from "next/link";
import { fmtInt } from "@/lib/format";
import { hrefWith, type Params } from "@/lib/url";

export const PAGE_SIZE = 25;

/** 1 … 4 5 6 … 20 — same windowing as the old pageNumbers(). */
function pageNumbers(cur: number, total: number): Array<number | "…"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: Array<number | "…"> = [1];
  if (cur > 3) out.push("…");
  for (let n = Math.max(2, cur - 1); n <= Math.min(total - 1, cur + 1); n++)
    out.push(n);
  if (cur < total - 2) out.push("…");
  out.push(total);
  return out;
}

/**
 * Page links carry every other query parameter, and drop `sel`: a selected
 * row belongs to the page it was on.
 */
export function Pager({
  params,
  page,
  total,
}: {
  params: Params;
  page: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const end = Math.min(page * PAGE_SIZE, total);
  const href = (n: number) => hrefWith(params, { page: n === 1 ? null : n, sel: null });

  return (
    <div className="pager">
      <div className="info">
        {total ? `${start}–${end} de ${fmtInt(total)}` : ""}
      </div>
      {pages > 1 && (
        <div className="btns">
          <PageButton href={href(page - 1)} disabled={page === 1}>
            ‹
          </PageButton>
          {pageNumbers(page, pages).map((n, i) =>
            n === "…" ? (
              <span key={`e${i}`} className="ellip">
                …
              </span>
            ) : (
              <PageButton key={n} href={href(n)} current={n === page}>
                {n}
              </PageButton>
            ),
          )}
          <PageButton href={href(page + 1)} disabled={page === pages}>
            ›
          </PageButton>
        </div>
      )}
    </div>
  );
}

function PageButton({
  href,
  current,
  disabled,
  children,
}: {
  href: string;
  current?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <button type="button" disabled>
        {children}
      </button>
    );
  }
  return (
    <Link href={href} className={current ? "current" : undefined} role="button">
      {children}
    </Link>
  );
}
