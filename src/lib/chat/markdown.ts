import type { FavoriteInput } from "@/lib/favorites";
import { addDays, formatDate, parseWallClock, startOfDay } from "@/lib/wallclock";

/**
 * The assistant's reply, turned into something the panel can show. Port of
 * parseMarker() and mdToHtml() in static/app.js. Pure, so tests/chat.test.ts
 * can pin the marker contract without a browser.
 */

/** One marker line per option the model recommends — see prompt.ts. */
const MARKER_RE = /^\[(TRIP|FLIGHT|PACKAGE)\]\s*(.+)$/;

export function parseMarker(line: string): FavoriteInput | null {
  const m = MARKER_RE.exec(line.trim());
  if (!m) return null;
  const parts = m[2].split("|").map((s) => s.trim());
  if (m[1] === "TRIP" && parts.length === 4) {
    const [oa, od, ra, rd] = parts;
    if (!oa || !od || !ra || !rd) return null;
    return {
      kind: "trip",
      outOrigin: oa,
      outDestination: "ALC",
      outDeparture: od,
      retOrigin: "ALC",
      retDestination: ra,
      retDeparture: rd,
    };
  }
  if (m[1] === "PACKAGE" && parts.length === 4) {
    const [origin, dest, day, nightsText] = parts;
    const nights = parseInt(nightsText, 10);
    if (!origin || !dest || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !(nights > 0)) return null;
    // Zone-free date arithmetic: the old code went through a Date here.
    const back = addDays(startOfDay(parseWallClock(day)), nights);
    return {
      kind: "package",
      outOrigin: origin,
      outDestination: dest,
      outDeparture: `${day}T00:00:00`,
      retOrigin: dest,
      retDestination: origin,
      retDeparture: `${formatDate(back)}T00:00:00`,
    };
  }
  if (m[1] === "FLIGHT" && parts.length === 3) {
    const [o, d, dep] = parts;
    if (!o || !d || !dep) return null;
    return {
      kind: "flight",
      outOrigin: o,
      outDestination: d,
      outDeparture: dep,
      retOrigin: null,
      retDestination: null,
      retDeparture: null,
    };
  }
  return null;
}

/**
 * Minimal markdown for chat replies. Escapes HTML first, so model output can
 * never inject markup. Handles bold/italic/code, bullet lists, rules,
 * headings (as bold paragraphs, the sidebar is narrow).
 */
export function mdToHtml(src: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  const out: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (list) {
      out.push(`<ul>${list.join("")}</ul>`);
      list = null;
    }
  };
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(t)) {
      flush();
      out.push("<hr>");
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h) {
      flush();
      out.push(`<p class="h">${inline(h[1])}</p>`);
      continue;
    }
    // Markers become cards; a half-streamed one is hidden rather than shown raw.
    if (/^\[(TRIP|FLIGHT|PACKAGE)\]/.test(t)) {
      flush();
      continue;
    }
    const li = /^[*\-•]\s+(.*)$/.exec(t);
    if (li) {
      (list ??= []).push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    flush();
    out.push(`<p>${inline(t)}</p>`);
  }
  flush();
  return out.join("");
}

/** A reply split into text runs and the cards the markers become. */
export type ReplyPart = { kind: "html"; html: string } | { kind: "card"; fav: FavoriteInput };

export function splitReply(content: string): ReplyPart[] {
  const parts: ReplyPart[] = [];
  let buf: string[] = [];
  const flushText = () => {
    if (buf.length) {
      parts.push({ kind: "html", html: mdToHtml(buf.join("\n")) });
      buf = [];
    }
  };
  for (const line of content.split("\n")) {
    const fav = parseMarker(line);
    if (fav) {
      flushText();
      parts.push({ kind: "card", fav });
    } else buf.push(line);
  }
  flushText();
  return parts;
}
