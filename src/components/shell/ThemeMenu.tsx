"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Light / dark / system. Port of the theme half of shell.js.
 *
 * The choice is `data-theme` on <html> (absent = system) and persists in
 * localStorage; the inline script in layout.tsx applies it before first
 * paint. The current value is read from <html> through
 * useSyncExternalStore, with "system" as the server snapshot, so the menu
 * hydrates cleanly and then shows the real choice. Charts draw with CSS
 * variables in `style`, so nothing needs repainting on a switch.
 */

type Theme = "light" | "dark" | "system";

const ICON: Record<Theme, string> = { light: "☀", dark: "☾", system: "◐" };
const LABEL: Record<Theme, string> = {
  light: "Claro",
  dark: "Oscuro",
  system: "Sistema",
};

function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function currentTheme(): Theme {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" || t === "dark" ? t : "system";
}

export function ThemeMenu() {
  const theme = useSyncExternalStore<Theme>(
    subscribeToTheme,
    currentTheme,
    () => "system",
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  function apply(next: Theme) {
    const html = document.documentElement;
    if (next === "system") html.removeAttribute("data-theme");
    else html.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {}
    setOpen(false);
  }

  return (
    <div className="menu-wrap">
      <button
        type="button"
        className="icon-btn"
        title="Tema"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <span>{ICON[theme]}</span>
        <span>Tema</span>
      </button>
      <div className={`menu${open ? " open" : ""}`}>
        {(["light", "dark", "system"] as Theme[]).map((t) => (
          <button key={t} type="button" onClick={() => apply(t)}>
            <span>{ICON[t]}</span> {LABEL[t]}
            <span className="check">{theme === t ? "✓" : ""}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
