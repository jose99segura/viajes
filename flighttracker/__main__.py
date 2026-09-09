from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta

from tabulate import tabulate

from . import db
from . import obs
from .config import load_config
from . import alerts as alerts_mod
from .providers import google, luxair, ryanair
from .scoring import airport_ground, convenience_adjustment


# A provider that answers with far less than last time is more likely to be
# broken than the market is to have emptied. The gate is a ratio rather than a
# fixed floor, because 200 fares dropping to 3 and 20 dropping to 0 are the
# same event at two different scales.
SUSPECT_RATIO = 0.25

# Below this, a drop is noise. A route with 4 fares can legitimately have 1
# tomorrow, and alerting on that would train you to ignore the alerts.
SUSPECT_MIN_BASELINE = 8


def _trusted(conn, provider: str, route: str | None, found: int, s) -> bool:
    """Should this answer be written to the snapshot?

    Compares against the last attempt at the same step that succeeded, not
    against a constant: what "normal" means for HHN-ALC and for LUX-ALC are
    different numbers, and hard coding either would be wrong for the other.

    With no baseline the answer is always yes. A gate that blocks the first
    run of a new route is a gate that stops the system from growing.
    """
    baseline = db.last_ok_count(conn, provider, route)
    if baseline is None or baseline < SUSPECT_MIN_BASELINE:
        return True
    if found >= baseline * SUSPECT_RATIO:
        return True
    s.suspect(f"found {found} fares, last good run found {baseline}")
    return False


def _record(conn, captured_at: str, s) -> None:
    db.record_run(conn, captured_at, s.provider, s.route, s.status,
                  s.found, s.stored, s.duration_ms, s.error)


def cmd_fetch(args: argparse.Namespace) -> None:
    obs.configure()
    cfg = load_config()
    conn = db.connect()
    captured_at = db.run_timestamp()
    total = 0

    for route in cfg.routes:
        origin, dest = route["origin"], route["destination"]
        leg = f"{origin}-{dest}"
        with obs.step("ryanair", leg) as s:
            fares = ryanair.fetch(origin, dest, cfg.months_ahead, cfg.currency)
            s.found = len(fares)
            if fares and _trusted(conn, "ryanair", leg, s.found, s):
                s.stored = db.insert_fares(conn, fares, captured_at)
                total += s.stored
        _record(conn, captured_at, s)

    for origin, dest in cfg.luxair.routes:
        leg = f"{origin}-{dest}"
        with obs.step("luxair", leg) as s:
            pkgs = luxair.fetch(origin, dest, cfg.months_ahead,
                                cfg.luxair.nights, cfg.currency)
            s.found = len(pkgs)
            if pkgs and _trusted(conn, "luxair", leg, s.found, s):
                s.stored = db.insert_packages(conn, pkgs, captured_at)
                total += s.stored
        _record(conn, captured_at, s)

    if args.google:
        if not google.AVAILABLE:
            # Not a failed attempt: the dependency is optional by design, and
            # recording it as a failure would fire an alert on every run of a
            # machine that never had it.
            obs.log.warning("fast-flights not installed, skipping Google Flights")
        else:
            weeks = args.google_weeks or cfg.google.weeks
            days = _sample_days(weeks, cfg.google.weekdays)
            for route in cfg.routes:
                origin, dest = route["origin"], route["destination"]
                leg = f"{origin}-{dest}"
                # Google is sampled day by day, so one bad day must not lose
                # the other forty. Failures are counted and reported once for
                # the route rather than aborting it.
                with obs.step("google", leg) as s:
                    collected: list[dict] = []
                    day_failures = 0
                    for day in days:
                        try:
                            collected.extend(
                                google.fetch_day(origin, dest, day, cfg.currency))
                        except Exception as exc:  # noqa: BLE001 - one day, not the route
                            day_failures += 1
                            obs.log.warning("google day failed", extra={
                                "route": leg, "day": day.isoformat(),
                                "error": str(exc)})
                    s.found = len(collected)
                    if day_failures:
                        s.error = f"{day_failures}/{len(days)} days failed"
                    if collected and _trusted(conn, "google", leg, s.found, s):
                        s.stored = db.insert_fares(conn, collected, captured_at)
                        total += s.stored
                _record(conn, captured_at, s)

    obs.log.info("fetch finished", extra={
        "captured_at": captured_at, "fares_stored": total})
    obs.notify_failures(captured_at)
    print(f"Stored {total} fares.")
    _print_alerts(alerts_mod.evaluate(cfg, conn, record=True), only_new=True)


def cmd_runs(args: argparse.Namespace) -> None:
    """Answer "did the 09:00 fetch work" without reading container logs."""
    conn = db.connect()
    rows = db.recent_runs(conn, args.limit)
    if not rows:
        print("No runs recorded yet.")
        return
    print(tabulate(
        [[r["captured_at"][:16], r["provider"], r["route"] or "", r["status"],
          r["fares_found"], r["fares_stored"], f"{r['duration_ms']}ms",
          (r["error"] or "")[:60]] for r in rows],
        headers=["run", "provider", "route", "status", "found", "stored",
                 "took", "error"]))


def _fmt_trip(c: dict) -> str:
    def when(leg):
        d = leg["departure"]
        return d[:10] if leg.get("date_only") else d[:16].replace("T", " ")
    # Show what the trip really costs, not just the fare: the alerts are
    # ranked by effective cost, so printing the ticket alone reads as if the
    # list were out of order.
    return (f"{c['out']['origin']}->ALC {when(c['out'])}  ->  "
            f"ALC->{c['ret']['destination']} {when(c['ret'])}  "
            f"{c['nights']}n  {c['days_off']} dias libres  "
            f"{c['price']:.2f} EUR billete  "
            f"{c['effective']:.2f} EUR efectivo  ({c['out']['airline']})")


def _print_alerts(results: list[dict], only_new: bool) -> None:
    print()
    for r in results:
        a = r["alert"]
        if not a["enabled"]:
            continue
        shown = [m for m in r["matches"] if m["is_new"]] if only_new else r["matches"]
        head = f"[{a['name']}] {r['total']} coincidencias"
        if only_new:
            head += f", {len(shown)} nuevas"
        print(head)
        for m in shown[:10]:
            print(f"   {'NEW ' if m['is_new'] else '    '}{_fmt_trip(m)}")


def cmd_alerts(args: argparse.Namespace) -> None:
    cfg = load_config()
    _print_alerts(alerts_mod.evaluate(cfg, record=False), only_new=False)


def _sample_days(weeks: int, weekdays: list[int]) -> list:
    """Upcoming dates falling on the configured weekdays (0=Mon .. 6=Sun)."""
    today = datetime.now().date()
    wanted = set(weekdays)
    return [
        d for d in (today + timedelta(days=n + 1) for n in range(weeks * 7))
        if d.weekday() in wanted
    ]


def cmd_report(args: argparse.Namespace) -> None:
    cfg = load_config()
    conn = db.connect()
    rows = db.latest_snapshot(conn)
    scored = []
    for r in rows:
        if args.route:
            o, d = args.route.upper().split("-")
            if r["origin"] != o or r["destination"] != d:
                continue
        try:
            dep = datetime.fromisoformat(r["departure"])
        except ValueError:
            continue
        if args.max_price and r["price"] > args.max_price:
            continue
        adj, label = convenience_adjustment(dep, cfg.scoring)
        home = (r["destination"] if r["destination"] != "ALC" else r["origin"])
        ground, _ = airport_ground(home, cfg.travel)
        scored.append(
            {
                "route": f"{r['origin']}->{r['destination']}",
                "departure": dep.strftime("%a %d %b %H:%M"),
                "airline": r["airline"] or "?",
                "price": r["price"],
                "adj": f"{adj:+.0f}",
                "car": f"{ground:+.0f}",
                "effective": r["price"] + adj + ground,
                "when": label,
                "source": r["source"],
                "_dep": dep,
            }
        )
    scored.sort(key=lambda x: x["effective"])
    top = scored[: args.top]
    for row in top:
        row.pop("_dep")
        row["price"] = f"{row['price']:.2f}"
        row["effective"] = f"{row['effective']:.2f}"
    if not top:
        print("No fares stored yet. Run: python -m flighttracker fetch")
        return
    print(tabulate(top, headers="keys", tablefmt="rounded_outline"))
    print(f"\n{len(scored)} future fares tracked. 'effective' = price + convenience "
          f"adjustment + driving to that airport ({cfg.currency}); lower is better.")


def cmd_history(args: argparse.Namespace) -> None:
    conn = db.connect()
    origin, dest = args.route.upper().split("-")
    rows = db.price_history(conn, origin, dest, args.date)
    if not rows:
        print("No history for that route/date yet.")
        return
    table = [
        {
            "captured": r["captured_at"][:16].replace("T", " "),
            "departure": r["departure"][:16].replace("T", " "),
            "airline": r["airline"] or "?",
            "price": f"{r['price']:.2f} {r['currency']}",
            "source": r["source"],
        }
        for r in rows
    ]
    print(tabulate(table, headers="keys", tablefmt="rounded_outline"))


def cmd_models(args: argparse.Namespace) -> None:
    from . import chat

    try:
        names = chat.list_gemini_models()
    except chat.MissingCredentials as exc:
        print(exc, file=sys.stderr)
        return
    print(f"Modelos disponibles para tu clave ({len(names)}):")
    for n in sorted(names):
        mark = "  <- configurado" if n == chat.GEMINI_MODEL else ""
        print(f"  {n}{mark}")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="flighttracker",
        description="Track flight prices LUX/SCN/HHN <-> ALC and rank by "
        "price + work-schedule convenience.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_fetch = sub.add_parser("fetch", help="scrape current prices into the DB")
    p_fetch.add_argument("--google", action="store_true",
                         help="also sample Google Flights for upcoming weekends")
    p_fetch.add_argument("--google-weeks", type=int, default=None,
                         help="override config.yaml google.weeks")
    p_fetch.set_defaults(func=cmd_fetch)

    p_report = sub.add_parser("report", help="best upcoming flights by effective cost")
    p_report.add_argument("--route", help="filter, e.g. HHN-ALC")
    p_report.add_argument("--top", type=int, default=25)
    p_report.add_argument("--max-price", type=float)
    p_report.set_defaults(func=cmd_report)

    p_hist = sub.add_parser("history", help="price evolution for one route+day")
    p_hist.add_argument("route", help="e.g. HHN-ALC")
    p_hist.add_argument("date", help="YYYY-MM-DD")
    p_hist.set_defaults(func=cmd_history)

    p_alerts = sub.add_parser("alerts", help="show current matches for every alert rule")
    p_alerts.set_defaults(func=cmd_alerts)

    p_runs = sub.add_parser("runs", help="recent fetch attempts and their outcome")
    p_runs.add_argument("--limit", type=int, default=30)
    p_runs.set_defaults(func=cmd_runs)

    p_models = sub.add_parser("models", help="list Gemini models your key can use")
    p_models.set_defaults(func=cmd_models)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
