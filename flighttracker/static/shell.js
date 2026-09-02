"use strict";
/* Shared app shell: theme switching and the collapsible sidebar.
   Loaded by every page; app.js may define window.onThemeChange to repaint
   anything drawn with resolved colour values. */

const $ = id => document.getElementById(id);

// ---------- app shell: theme + collapsible sidebar ----------

const THEMES = ["light", "dark", "system"];
const THEME_ICON = { light: "☀", dark: "☾", system: "◐" };

function currentTheme() {
  try { return localStorage.getItem("theme") || "system"; } catch (e) { return "system"; }
}

function applyTheme(name) {
  if (name === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = name;
  try { localStorage.setItem("theme", name); } catch (e) {}
  $("themeIcon").textContent = THEME_ICON[name] || THEME_ICON.system;
  for (const b of $("themeMenu").querySelectorAll("button")) {
    b.querySelector(".check").textContent =
      b.dataset.setTheme === name ? "✓" : "";
  }
  if (typeof window.onThemeChange === "function") window.onThemeChange();
}

function setNavCollapsed(collapsed) {
  document.body.classList.toggle("nav-collapsed", collapsed);
  $("navIcon").textContent = collapsed ? "»" : "«";
  $("navToggle").dataset.tip = collapsed ? "Expandir menú" : "Contraer menú";
  $("navToggle").querySelector(".label").textContent = "Contraer menú";
  $("navToggle").title = collapsed ? "Expandir menú" : "Contraer menú";
  try { localStorage.setItem("nav", collapsed ? "collapsed" : "open"); } catch (e) {}
}

function initShell() {
  applyTheme(currentTheme());
  // Saved preference wins; with none, start collapsed on a narrow window.
  // Only JS decides this, so the toggle always works at any width.
  let collapsed = document.documentElement.classList.contains("pre-collapsed");
  try {
    if (localStorage.getItem("nav") === null) collapsed = window.innerWidth < 1180;
  } catch (e) {}
  setNavCollapsed(collapsed);
  document.documentElement.classList.remove("pre-collapsed");

  $("navToggle").addEventListener("click", () =>
    setNavCollapsed(!document.body.classList.contains("nav-collapsed")));

  $("themeBtn").addEventListener("click", ev => {
    ev.stopPropagation();
    $("themeMenu").classList.toggle("open");
  });
  for (const b of $("themeMenu").querySelectorAll("button")) {
    b.addEventListener("click", () => {
      applyTheme(b.dataset.setTheme);
      $("themeMenu").classList.remove("open");
    });
  }
  document.addEventListener("click", () => $("themeMenu").classList.remove("open"));

  // Follow the OS while on "system" so the chart recolours live.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentTheme() === "system") applyTheme("system");
  });
}


initShell();
