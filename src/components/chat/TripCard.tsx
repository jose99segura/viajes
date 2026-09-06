"use client";

import { useTransition } from "react";
import { toggleFavorite } from "@/app/actions";
import { bookingLinkForLeg, type BookingLink } from "@/lib/booking";
import { fmtDep } from "@/lib/format";
import type { FavoriteInput } from "@/lib/favorites";
import { dayNumber, parseWallClock } from "@/lib/wallclock";

/**
 * A card the panel renders in place of a marker line: the option the model
 * recommended, with a save button and a booking link. Port of tripCard().
 *
 * The model does not know which provider quoted a fare, so trip/flight
 * markers fall back to a Google Flights search — bookingLinkForLeg does
 * that for any source it does not recognise. Luxair packages get their own.
 */
export function TripCard({
  fav,
  saved,
  onToggled,
}: {
  fav: FavoriteInput;
  saved: boolean;
  onToggled: () => void;
}) {
  const [pending, start] = useTransition();
  const round = fav.kind === "trip" || fav.kind === "package";
  const pkg = fav.kind === "package";

  const title = round
    ? `${fav.outOrigin} → ${fav.outDestination} → ${fav.retDestination}${pkg ? " · Luxair" : ""}`
    : `${fav.outOrigin} → ${fav.outDestination}`;

  // Two text lines; formatting can throw on a malformed marker, in which
  // case the raw departure is shown. Strings in the try, JSX outside it.
  let line1: string;
  let line2: string | null = null;
  try {
    if (pkg && fav.retDeparture) {
      const nights =
        dayNumber(parseWallClock(fav.retDeparture)) - dayNumber(parseWallClock(fav.outDeparture));
      line1 = `Ida ${fmtDep(fav.outDeparture, true)} · vuelta ${fmtDep(fav.retDeparture, true)}`;
      line2 = `${nights} noches · sin horas publicadas`;
    } else if (round && fav.retDeparture) {
      line1 = `Ida ${fmtDep(fav.outDeparture)}`;
      line2 = `Vuelta ${fmtDep(fav.retDeparture)}`;
    } else {
      line1 = fmtDep(fav.outDeparture);
    }
  } catch {
    line1 = fav.outDeparture;
  }
  const when = (
    <>
      {line1}
      {line2 && (
        <>
          <br />
          {line2}
        </>
      )}
    </>
  );

  let links: BookingLink[];
  if (pkg) {
    links = [bookingLinkForLeg("luxair", fav.outOrigin, fav.outDestination, fav.outDeparture)];
  } else if (round && fav.retDeparture) {
    links = [
      bookingLinkForLeg("", fav.outOrigin, fav.outDestination, fav.outDeparture, fav.retDeparture),
    ];
  } else {
    links = [bookingLinkForLeg("", fav.outOrigin, fav.outDestination, fav.outDeparture)];
  }

  return (
    <div className="tripcard">
      <div className="r">{title}</div>
      <div className="d">{when}</div>
      <div className="act">
        <button
          type="button"
          className={saved ? "on" : undefined}
          disabled={pending}
          onClick={() =>
            start(async () => {
              await toggleFavorite(fav);
              onToggled();
            })
          }
        >
          {saved ? "★ Guardado" : "☆ Guardar"}
        </button>
        {links.map((l) => (
          <a
            key={l.url}
            className={`book-link small${l.muted ? " muted" : ""}`}
            href={l.url}
            target="_blank"
            rel="noopener"
            title={l.title}
          >
            {l.label} ↗
          </a>
        ))}
      </div>
    </div>
  );
}
