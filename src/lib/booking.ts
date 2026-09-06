import type { Trip } from "./trips";

/**
 * Booking links. Port of the same section of static/app.js.
 *
 * Ryanair's own deep-link format (originIata/destinationIata/dateOut/dateIn)
 * is stable and widely used, so we can prefill it exactly. Luxair's booking
 * engine has no documented deep-link parameters and sits behind bot
 * protection (see /info) — we only know the real luxair.lu URL works, not
 * how to prefill it, so that link is honest about needing manual dates.
 * Anything else (Google-sourced fares, mixed-source pairings) falls back to
 * a Google Flights search query, which resolves for any airport pair.
 */

export interface BookingLink {
  label: string;
  url: string;
  muted?: boolean;
  title?: string;
}

const day = (wallClock: string) => wallClock.slice(0, 10);

export function bookingLinkForLeg(
  source: string,
  origin: string,
  destination: string,
  departure: string,
  returnDeparture?: string,
): BookingLink {
  const dateOut = day(departure);
  if (source === "ryanair") {
    const p = new URLSearchParams({
      adults: "1",
      teens: "0",
      children: "0",
      infants: "0",
      dateOut,
      isConnectedFlight: "false",
      discount: "0",
      promoCode: "",
      originIata: origin,
      destinationIata: destination,
      isReturn: returnDeparture ? "true" : "false",
    });
    if (returnDeparture) p.set("dateIn", day(returnDeparture));
    return {
      label: returnDeparture
        ? "Reservar ida y vuelta · Ryanair"
        : "Reservar · Ryanair",
      url: `https://www.ryanair.com/es/es/trip/flights/select?${p}`,
    };
  }
  if (source === "luxair") {
    return {
      label: "Buscar en luxair.lu",
      url: "https://www.luxair.lu/en",
      muted: true,
      title:
        `Luxair no permite enlazar la búsqueda ya rellena — se abre su web, ` +
        `introduce ${origin} → ${destination} el ${dateOut}.`,
    };
  }
  const q = returnDeparture
    ? `Flights from ${origin} to ${destination} on ${dateOut} through ${day(returnDeparture)}`
    : `Flights from ${origin} to ${destination} on ${dateOut}`;
  return {
    label: "Buscar en Google Flights",
    url: `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`,
    muted: true,
  };
}

/**
 * Round trip → one combined Ryanair link when both legs are Ryanair (its
 * own flow searches both at once), otherwise one link per leg since a
 * single URL cannot span two different sites.
 */
export function bookingLinksForTrip(t: Trip): BookingLink[] {
  if (t.isPackage) {
    return [
      bookingLinkForLeg("luxair", t.out.origin, t.out.destination, t.out.departure),
    ];
  }
  if (t.out.source === "ryanair" && t.ret.source === "ryanair") {
    return [
      bookingLinkForLeg("ryanair", t.out.origin, "ALC", t.out.departure, t.ret.departure),
    ];
  }
  return [
    bookingLinkForLeg(t.out.source, t.out.origin, "ALC", t.out.departure),
    bookingLinkForLeg(t.ret.source, "ALC", t.ret.destination, t.ret.departure),
  ];
}
