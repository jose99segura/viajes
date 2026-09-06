"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

/**
 * The collapsible icon sidebar. Port of the nav in index.html plus the
 * collapse half of shell.js.
 *
 * The collapsed state is a class on <html>, set before first paint by the
 * inline script in layout.tsx. This component reads it through
 * useSyncExternalStore — the server snapshot is "open", the client snapshot
 * is the real class — so React renders the server markup during hydration
 * and then corrects the chevron, with no mismatch and no effect.
 */

function subscribeToHtmlClass(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const isCollapsed = () =>
  document.documentElement.classList.contains("nav-collapsed");

const NAV = [
  { group: "Buscar" },
  { href: "/", icon: "⇄", label: "Ida y vuelta" },
  { href: "/solo-ida", icon: "→", label: "Solo ida" },
  { href: "/calendario", icon: "▦", label: "Calendario" },
  { href: "/alertas", icon: "◔", label: "Alertas", badge: "unseen" },
  { group: "Guardado" },
  { href: "/favoritos", icon: "★", label: "Favoritos", badge: "favorites" },
  { group: "Ayuda" },
  { href: "/info", icon: "?", label: "Cómo funciona" },
] as const;

export function Sidebar({
  favorites,
  unseen,
}: {
  favorites: number;
  unseen: number;
}) {
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(
    subscribeToHtmlClass,
    isCollapsed,
    () => false,
  );

  function toggle() {
    const next = !collapsed;
    // The class change is what re-renders us, via the observer above.
    document.documentElement.classList.toggle("nav-collapsed", next);
    try {
      localStorage.setItem("nav", next ? "collapsed" : "open");
    } catch {}
  }

  const badges = { unseen, favorites };
  const tip = collapsed ? "Expandir menú" : "Contraer menú";

  return (
    <nav className="sidebar" id="sidebar">
      <div className="brand">
        <span className="mark">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="M22 2L15 22L11 13L2 9L22 2Z" fill="currentColor" />
            <path
              d="M22 2L11 13"
              stroke="var(--accent)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <b>viajes</b>
      </div>

      <div className="nav">
        {NAV.map((item, i) =>
          "group" in item ? (
            <div key={i} className="group">
              {item.group}
            </div>
          ) : (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? "active" : undefined}
              data-tip={item.label}
            >
              <span className="ico">{item.icon}</span>
              <span className="label">{item.label}</span>
              {"badge" in item && badges[item.badge] > 0 && (
                <span className="badge-count">({badges[item.badge]})</span>
              )}
            </Link>
          ),
        )}
      </div>

      <div className="foot">
        <button type="button" onClick={toggle} data-tip={tip} title={tip}>
          <span className="ico">{collapsed ? "»" : "«"}</span>
          <span className="label">Contraer menú</span>
        </button>
      </div>
    </nav>
  );
}
