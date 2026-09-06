from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta

from tabulate import tabulate

from . import db
from .config import load_config
from . import alerts as alerts_mod
from .providers import google, luxair, ryanair
from .scoring import airport_ground, convenience_adjustment


def cmd_fetch(args: argparse.Namespace) -> None:
    cfg = load_config()
    conn = db.connect()
    captured_at = db.run_timestamp()
    total = 0
    for route in cfg.routes:
        origin, dest = route["origin"], route["destination"]
        try:
            fares = ryanair.fetch(origin, dest, cfg.months_ahead, cfg.currency)
        except Exception as exc:  # noqa: BLE001 - keep tracking other routes
            print(f"  {origin}->{dest} ryanair FAILED: {exc}", file=sys.stderr)
            continue
        n = db.insert_fares(conn, fares, captured_at) if fares else 0
        total += n
        note = "" if fares else "  (no Ryanair route)"
        print(f"  {origin}->{dest} ryanair: {n} fares{note}")

    for origin, dest in cfg.luxair.routes:
        try:
            pkgs = luxair.fetch(origin, dest, cfg.months_ahead,
                                cfg.luxair.nights, cfg.currency)
        except Exception as exc:  # noqa: BLE001
            print(f"  {origin}->{dest} luxair FAILED: {exc}", file=sys.stderr)
            continue
        n = db.insert_packages(conn, pkgs, captured_at) if pkgs else 0
        total += n
        cheapest = f", desde {min(p['price'] for p in pkgs):.0f} EUR" if pkgs else ""
        print(f"  {origin}->{dest} luxair: {n} round-trip fares{cheapest}")

    if args.google:
        if not google.AVAILABLE:
            print("fast-flights not installed; skipping Google Flights", file=sys.stderr)
        else:
            weeks = args.google_weeks or cfg.google.weeks
            days = _sample_days(weeks, cfg.google.weekdays)
            print(f"  google: sampling {len(days)} days over {weeks} weeks")
            for route in cfg.routes:
                origin, dest = route["origin"], route["destination"]
                found = direct = 0
                for day in days:
                    try:
                        fares = google.fetch_day(origin, dest, day, cfg.currency)
                    except Exception as exc:  # noqa: BLE001
                        print(f"  {origin}->{dest} {day} google FAILED: {exc}", file=sys.stderr)
                        continue
                    if fares:
                        total += db.insert_fares(conn, fares, captured_at)
                        found += len(fares)
                        direct += sum(1 for f in fares if f.get("stops") == 0)
                print(f"  {origin}->{dest} google: {found} fares ({direct} non-stop)")
    print(f"Stored {total} fares.")
    _print_alerts(alerts_mod.evaluate(cfg, conn, record=True), only_new=True)


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

    p_models = sub.add_parser("models", help="list Gemini models your key can use")
    p_models.set_defaults(func=cmd_models)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
