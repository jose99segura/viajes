import { describe, expect, it } from "vitest";
import { mdToHtml, parseMarker, splitReply } from "@/lib/chat/markdown";
import { favoriteKey } from "@/lib/favorites";

/**
 * The marker contract between the prompt (src/lib/chat/prompt.ts) and the
 * panel: one line per option, parsed into the same favourite identity the
 * pages use, so "☆ Guardar" on a card saves exactly what the star on a row
 * would.
 */

describe("markers", () => {
  it("parses a round trip", () => {
    const fav = parseMarker("[TRIP]SCN|2026-09-10T22:00:00|HHN|2026-09-13T21:25:00")!;
    expect(fav).toEqual({
      kind: "trip",
      outOrigin: "SCN",
      outDestination: "ALC",
      outDeparture: "2026-09-10T22:00:00",
      retOrigin: "ALC",
      retDestination: "HHN",
      retDeparture: "2026-09-13T21:25:00",
    });
    expect(favoriteKey(fav)).toBe("trip|SCN|ALC|2026-09-10T22:00:00|ALC|HHN|2026-09-13T21:25:00");
  });

  it("parses a Luxair package and computes the return date without a Date", () => {
    // 2026-11-21 + 14 nights = 2026-12-05, across a month boundary.
    const fav = parseMarker("[PACKAGE]LUX|ALC|2026-11-21|14")!;
    expect(fav.kind).toBe("package");
    expect(fav.outDeparture).toBe("2026-11-21T00:00:00");
    expect(fav.retDeparture).toBe("2026-12-05T00:00:00");
    // The identity the favourites page stores for the same package.
    expect(favoriteKey(fav)).toBe(
      "package|LUX|ALC|2026-11-21T00:00:00|ALC|LUX|2026-12-05T00:00:00",
    );
  });

  it("parses a one-way flight with NULL return columns", () => {
    const fav = parseMarker("[FLIGHT]HHN|ALC|2026-10-25T09:45:00")!;
    expect(fav.kind).toBe("flight");
    expect(fav.retOrigin).toBeNull();
    expect(favoriteKey(fav)).toBe("flight|HHN|ALC|2026-10-25T09:45:00|||");
  });

  it("rejects malformed markers rather than guessing", () => {
    expect(parseMarker("[TRIP]SCN|2026-09-10T22:00:00|HHN")).toBeNull();
    expect(parseMarker("[PACKAGE]LUX|ALC|21/11/2026|14")).toBeNull();
    expect(parseMarker("[PACKAGE]LUX|ALC|2026-11-21|0")).toBeNull();
    expect(parseMarker("Un viaje [TRIP]SCN|a|b|c")).toBeNull();
  });
});

describe("markdown", () => {
  it("escapes model output before adding markup", () => {
    expect(mdToHtml("<img src=x onerror=alert(1)> **ok**")).toBe(
      "<p>&lt;img src=x onerror=alert(1)&gt; <strong>ok</strong></p>",
    );
  });

  it("renders headings, lists and rules", () => {
    expect(mdToHtml("### Sáb 14 nov\n- ida 18:45\n- vuelta 06:40\n---\nfin")).toBe(
      '<p class="h">Sáb 14 nov</p><ul><li>ida 18:45</li><li>vuelta 06:40</li></ul><hr><p>fin</p>',
    );
  });

  it("splits a reply into text and cards where the markers were", () => {
    const parts = splitReply(
      "**Veredicto**\n### Finde 14 nov\n- barato\n[TRIP]SCN|2026-11-14T18:45:00|HHN|2026-11-15T06:40:00\nPor qué: es finde.",
    );
    expect(parts.map((p) => p.kind)).toEqual(["html", "card", "html"]);
    expect(parts[1].kind === "card" && parts[1].fav.outOrigin).toBe("SCN");
  });
});
