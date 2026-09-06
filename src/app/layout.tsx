import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Sidebar } from "@/components/shell/Sidebar";
import { sidebarCounts } from "@/db/queries";
import "./globals.css";

export const metadata: Metadata = {
  // Pages set only their own name; the suffix is applied here so a new page
  // cannot forget it.
  title: { default: "viajes", template: "%s · viajes" },
  applicationName: "viajes",
  description: "Seguimiento de precios de vuelos LUX / SCN / HHN ⇄ ALC",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfcfb" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a19" },
  ],
};

// Every page is built from the live snapshot, and the sidebar counts come
// from the database; nothing here can be prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * Runs before first paint, so the page never flashes the wrong theme or a
 * sidebar that then jumps closed. Same logic as the old index.html script
 * plus initShell(): a saved theme wins; a saved nav state wins; with no
 * saved nav state, start collapsed on a narrow window.
 *
 * It touches <html> only. React hydrates <body> and would object to a
 * className it did not render; <html> carries suppressHydrationWarning for
 * exactly this.
 */
const PRE_PAINT = `
try {
  var t = localStorage.getItem("theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  var nav = localStorage.getItem("nav");
  if (nav === "collapsed" || (nav === null && window.innerWidth < 1180))
    document.documentElement.classList.add("nav-collapsed");
} catch (e) {}
`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const counts = await sidebarCounts();
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        {/* beforeInteractive: injected into the server HTML ahead of any
            hydration script, which is what "before first paint" needs. */}
        <Script id="pre-paint" strategy="beforeInteractive">
          {PRE_PAINT}
        </Script>
      </head>
      <body>
        <div className="shell">
          <Sidebar favorites={counts.favorites} unseen={counts.unseen} />
          <div className="main">{children}</div>
        </div>
      </body>
    </html>
  );
}
