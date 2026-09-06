import Link from "next/link";
import { ThemeMenu } from "@/components/shell/ThemeMenu";
import { INFO_HTML } from "@/content/info";

/**
 * "Cómo funciona" — the documentation page, ported as-is from
 * static/info.html (see src/content/info.ts for why it is rendered as HTML).
 * Its topbar differs from the others: no snapshot age, a "back" link.
 */

export const metadata = { title: "Cómo funciona" };

export default function InfoPage() {
  return (
    <>
      <div className="topbar">
        <h1>Cómo funciona</h1>
        <div className="grow" />
        <ThemeMenu />
        <Link href="/" className="icon-btn primary">
          ← Volver al panel
        </Link>
      </div>
      <div className="content doc" dangerouslySetInnerHTML={{ __html: INFO_HTML }} />
    </>
  );
}
