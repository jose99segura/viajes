"""Local dashboard: `python -m flighttracker.web` then open http://localhost:5010"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from pathlib import Path

import json
import os

from flask import Flask, Response, jsonify, redirect, request, send_from_directory

from . import alerts as alerts_mod
from . import chat as chat_mod
from . import db
from .config import load_config
from .scoring import (airport_ground, arrival_adjustment,
                      convenience_adjustment, day_adjustment, days_off_cost,
                      trip_ground, work_days_used)
from .trips import TripFilter, build_trips

STATIC_DIR = Path(__file__).resolve().parent / "static"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
# Local single-user app: never serve a stale stylesheet or script after an edit.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


def _parse_dt(value) -> datetime | None:
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _page(name: str) -> Response:
    """Serve an HTML page with ?v=<mtime> appended to its own asset links, so a
    browser can never render an edited page against a cached stylesheet."""
    html = (STATIC_DIR / name).read_text(encoding="utf-8")
    for asset in ("app.css", "app.js", "shell.js"):
        path = STATIC_DIR / asset
        if path.exists():
            html = html.replace(f"/static/{asset}",
                                f"/static/{asset}?v={int(path.stat().st_mtime)}")
    # The ?v= trick only helps if the browser re-fetches the page that carries
    # those links; cached, it would keep pointing at the old asset versions.
    return Response(html, mimetype="text/html",
                    headers={"Cache-Control": "no-store"})


@app.get("/")
def index():
    return _page("index.html")


@app.get("/favicon.ico")
def favicon_ico():
    # Browsers request this unconditionally regardless of the <link rel=icon>
    # in the page head; redirect to the real (SVG) favicon so it doesn't 404.
    return redirect("/static/favicon.svg")


@app.get("/info")
def info():
    return _page("info.html")


@app.get("/api/flights")
def flights():
    cfg = load_config()
    conn = db.connect()
    try:
        rows = db.latest_snapshot(conn)
        out = []
        last_captured = None
        for r in rows:
            try:
                dep = datetime.fromisoformat(r["departure"])
            except ValueError:
                continue
            adj, label = convenience_adjustment(dep, cfg.scoring)
            at_home = r["destination"] != "ALC"
            arr_adj, arr_label = arrival_adjustment(
                _parse_dt(r["arrival"]), at_home, cfg.scoring)
            if arr_label:
                adj += arr_adj
                label = f"{label}, {arr_label}"
            # One leg says nothing about how long the car would sit at the
            # airport, so the drive counts and parking doesn't.
            home = r["destination"] if at_home else r["origin"]
            ground, ground_label = airport_ground(home, cfg.travel)
            if last_captured is None or r["captured_at"] > last_captured:
                last_captured = r["captured_at"]
            out.append(
                {
                    "origin": r["origin"],
                    "destination": r["destination"],
                    "departure": r["departure"],
                    "arrival": r["arrival"],
                    "airline": r["airline"],
                    "stops": r["stops"],
                    "price": r["price"],
                    "currency": r["currency"],
                    "adjustment": adj,
                    "ground": ground,
                    "ground_label": ground_label,
                    "effective": round(r["price"] + adj + ground, 2),
                    "label": label,
                    "source": r["source"],
                }
            )
        return jsonify({"flights": out, "last_captured": last_captured,
                        "currency": cfg.currency})
    finally:
        conn.close()


TRIP_CAP = 2000


def _trip_filter_from_request() -> TripFilter:
    a = request.args
    max_price = a.get("max_price", "")
    max_days = a.get("max_days_off", "")
    return TripFilter(
        min_nights=int(a.get("min_nights", 1)),
        max_nights=int(a.get("max_nights", 21)),
        airport=a.get("airport", "").upper(),
        when=a.get("when", ""),
        same_only=a.get("same_airport") == "1",
        direct_only=a.get("direct") == "1",
        max_price=float(max_price) if max_price else None,
        max_days_off=int(max_days) if max_days != "" else None,
    )


@app.get("/api/trips")
def trips():
    """Scored round trips. Filtering happens server-side, before the cap:
    there are tens of thousands of pairings, so a global top-N would hide
    every LUX trip behind cheaper Ryanair ones."""
    cfg = load_config()
    combos, last_captured = build_trips(cfg, _trip_filter_from_request())
    return jsonify({"trips": combos[:TRIP_CAP], "total": len(combos),
                    "capped": len(combos) > TRIP_CAP,
                    "last_captured": last_captured, "currency": cfg.currency})

@app.get("/api/history")
def history():
    origin = request.args.get("origin", "")
    destination = request.args.get("destination", "")
    day = request.args.get("day", "")
    if not (origin and destination and day):
        return jsonify({"error": "origin, destination and day are required"}), 400
    conn = db.connect()
    try:
        rows = db.price_history(conn, origin, destination, day)
        return jsonify(
            {
                "points": [
                    {
                        "captured_at": r["captured_at"],
                        "departure": r["departure"],
                        "airline": r["airline"],
                        "price": r["price"],
                        "source": r["source"],
                    }
                    for r in rows
                ]
            }
        )
    finally:
        conn.close()


@app.route("/api/favorites", methods=["GET", "POST", "DELETE"])
def favorites():
    cfg = load_config()
    conn = db.connect()
    try:
        if request.method in ("POST", "DELETE"):
            fav = request.get_json(silent=True) or {}
            required = ("kind", "out_origin", "out_destination", "out_departure")
            if not all(fav.get(k) for k in required):
                return jsonify({"error": f"faltan campos: {required}"}), 400
            if request.method == "POST":
                db.add_favorite(conn, fav)
            else:
                db.remove_favorite(conn, fav)

        out = []
        for r in db.list_favorites(conn):
            fav = dict(r)
            legs = [(r["out_origin"], r["out_destination"], r["out_departure"])]
            if r["ret_departure"]:
                legs.append((r["ret_origin"], r["ret_destination"], r["ret_departure"]))

            if r["kind"] == "package":
                # One quoted price for the whole trip; look it up as such.
                out_day = r["out_departure"][:10]
                nights = (date.fromisoformat(r["ret_departure"][:10])
                          - date.fromisoformat(out_day)).days
                now = db.current_package(conn, r["out_origin"],
                                         r["out_destination"], out_day, nights)
                ext = db.package_extremes(conn, r["out_origin"],
                                          r["out_destination"], out_day, nights)
                adj, label = day_adjustment(date.fromisoformat(out_day), cfg.scoring)
                ret_adj, ret_label = day_adjustment(
                    date.fromisoformat(r["ret_departure"][:10]), cfg.scoring)
                fav["legs"] = [{
                    "origin": r["out_origin"], "destination": r["out_destination"],
                    "departure": r["out_departure"], "date_only": True,
                    "airline": "Luxair", "stops": 0, "source": "luxair",
                    "price": now["price"] if now else None,
                    "low": ext["lo"] if ext else None,
                    "high": ext["hi"] if ext else None,
                    "adjustment": adj, "label": label,
                }, {
                    "origin": r["out_destination"], "destination": r["out_origin"],
                    "departure": r["ret_departure"], "date_only": True,
                    "airline": "Luxair", "stops": 0, "source": "luxair", "price": None,
                    "low": None, "high": None,
                    "adjustment": ret_adj, "label": ret_label,
                }]
                out_dt = datetime.fromisoformat(r["out_departure"])
                ret_dt = datetime.fromisoformat(r["ret_departure"])
                home = (r["out_destination"] if r["out_origin"] == "ALC"
                        else r["out_origin"])
                ground, ground_label = airport_ground(home, cfg.travel, nights)
                days_off = work_days_used(out_dt, ret_dt, cfg.scoring, True, True)
                holiday, holiday_label = days_off_cost(
                    days_off, out_dt, cfg.scoring, True)
                fav["price_now"] = now["price"] if now else None
                fav["ground"] = ground
                fav["ground_label"] = ground_label
                fav["days_off"] = days_off
                fav["holiday"] = holiday
                fav["holiday_label"] = holiday_label
                fav["adjustment"] = round(adj + ret_adj, 2)
                fav["effective_now"] = (
                    round(fav["price_now"] + adj + ret_adj + ground + holiday, 2)
                    if fav["price_now"] is not None else None)
                fav["package"] = True
                fav["delta"] = (round(fav["price_now"] - fav["price_at_save"], 2)
                                if fav["price_at_save"] and fav["price_now"] else None)
                fav["key"] = db.favorite_key(fav)
                out.append(fav)
                continue

            total_now = 0.0
            adj_total = 0.0
            fav["legs"] = []
            for origin, dest, dep in legs:
                now = db.current_price(conn, origin, dest, dep)
                ext = db.price_extremes(conn, origin, dest, dep)
                try:
                    adj, label = convenience_adjustment(
                        datetime.fromisoformat(dep), cfg.scoring)
                except ValueError:
                    adj, label = 0.0, ""
                price = now["price"] if now else None
                if price is not None:
                    total_now += price
                adj_total += adj
                fav["legs"].append({
                    "origin": origin, "destination": dest, "departure": dep,
                    "airline": now["airline"] if now else None,
                    "stops": now["stops"] if now else 0,
                    "source": now["source"] if now else None,
                    "price": price,
                    "low": ext["lo"] if ext else None,
                    "high": ext["hi"] if ext else None,
                    "adjustment": adj, "label": label,
                })
            fav["price_now"] = round(total_now, 2) if total_now else None
            out_dt = _parse_dt(r["out_departure"])
            ret_dt = _parse_dt(r["ret_departure"])
            if out_dt and ret_dt:
                nights = (ret_dt.date() - out_dt.date()).days
                ground, ground_label = trip_ground(
                    r["out_origin"], r["ret_destination"], nights, cfg.travel)
                days_off = work_days_used(out_dt, ret_dt, cfg.scoring)
                holiday, holiday_label = days_off_cost(
                    days_off, out_dt, cfg.scoring)
            else:
                # A one-way favourite: the drive counts, but nothing says how
                # long the car would wait, so parking and holiday stay out.
                home = (r["out_origin"] if r["out_destination"] == "ALC"
                        else r["out_destination"])
                ground, ground_label = airport_ground(home, cfg.travel)
                days_off, holiday, holiday_label = 0, 0.0, ""
            fav["ground"] = ground
            fav["ground_label"] = ground_label
            fav["days_off"] = days_off
            fav["holiday"] = holiday
            fav["holiday_label"] = holiday_label
            fav["adjustment"] = round(adj_total, 2)
            fav["effective_now"] = (
                round(fav["price_now"] + adj_total + ground + holiday, 2)
                if fav["price_now"] is not None else None)
            if fav["price_at_save"] and fav["price_now"]:
                fav["delta"] = round(fav["price_now"] - fav["price_at_save"], 2)
            else:
                fav["delta"] = None
            fav["key"] = db.favorite_key(fav)
            out.append(fav)
        return jsonify({"favorites": out})
    finally:
        conn.close()


@app.route("/api/alerts", methods=["GET", "POST"])
def alerts_collection():
    cfg = load_config()
    conn = db.connect()
    try:
        if request.method == "POST":
            data = request.get_json(silent=True) or {}
            db.save_alert(conn, data)
        results = alerts_mod.evaluate(cfg, conn, record=False)
        return jsonify({"alerts": results,
                        "unseen": sum(r["unseen"] for r in results)})
    finally:
        conn.close()


@app.route("/api/alerts/<int:alert_id>", methods=["PUT", "DELETE"])
def alerts_item(alert_id: int):
    conn = db.connect()
    try:
        if db.get_alert(conn, alert_id) is None:
            return jsonify({"error": "no existe"}), 404
        if request.method == "DELETE":
            db.delete_alert(conn, alert_id)
        else:
            db.save_alert(conn, request.get_json(silent=True) or {}, alert_id)
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.post("/api/alerts/seen")
def alerts_seen():
    data = request.get_json(silent=True) or {}
    conn = db.connect()
    try:
        db.mark_alert_seen(conn, data.get("alert_id"))
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.get("/api/calendar")
def calendar():
    """Best fare per day per direction, ranked the way the rest of the app
    ranks: by effective cost, not by ticket price. Otherwise a 22 EUR fare from
    an airport two hours away paints a greener day than a 107 EUR one from the
    airport down the road, and the calendar contradicts the trip list.

    Parking is left out — one day cell says nothing about how long the car
    would wait — so a day's effective cost is the ticket, the convenience
    adjustment and the drive there and back."""
    cfg = load_config()
    conn = db.connect()
    try:
        rows = db.latest_snapshot(conn)
    finally:
        conn.close()

    best: dict[str, dict[str, dict]] = {"out": {}, "ret": {}}
    airport = request.args.get("airport", "").upper()
    for r in rows:
        dep = _parse_dt(r["departure"])
        if dep is None:
            continue
        if r["destination"] == "ALC":
            home, side = r["origin"], "out"
        elif r["origin"] == "ALC":
            home, side = r["destination"], "ret"
        else:
            continue
        if airport and home != airport:
            continue
        adj, _ = convenience_adjustment(dep, cfg.scoring)
        arr_adj, _ = arrival_adjustment(
            _parse_dt(r["arrival"]), side == "ret", cfg.scoring)
        ground, _ = airport_ground(home, cfg.travel)
        effective = r["price"] + adj + arr_adj + ground
        day = r["departure"][:10]
        current = best[side].get(day)
        if current is None or effective < current["effective"]:
            best[side][day] = {"day": day, "price": round(r["price"], 2),
                               "effective": round(effective, 2),
                               "airport": home, "airline": r["airline"]}
    return jsonify({
        "outbound": [v for _, v in sorted(best["out"].items())],
        "inbound": [v for _, v in sorted(best["ret"].items())],
        "currency": cfg.currency,
    })


@app.post("/api/chat")
def chat():
    payload = request.get_json(silent=True) or {}
    messages = payload.get("messages") or []
    if not messages:
        return jsonify({"error": "messages requeridos"}), 400
    # Keep only the fields the API accepts, and cap history length.
    clean = [
        {"role": m["role"], "content": m["content"]}
        for m in messages[-20:]
        if m.get("role") in ("user", "assistant") and m.get("content")
    ]
    cfg = load_config()

    def events():
        try:
            for chunk in chat_mod.stream_reply(cfg, clean):
                yield f"data: {json.dumps({'text': chunk})}\n\n"
        except chat_mod.MissingCredentials as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
        except Exception as exc:  # noqa: BLE001 - surface it in the UI
            yield f"data: {json.dumps({'error': f'{type(exc).__name__}: {exc}'})}\n\n"
        yield "data: [DONE]\n\n"

    return Response(events(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/chat/status")
def chat_status():
    try:
        name, model = chat_mod.provider()
        return jsonify({"ready": True, "provider": name, "model": model})
    except chat_mod.MissingCredentials as exc:
        return jsonify({"ready": False, "reason": str(exc)})


def main() -> None:
    # 0.0.0.0 inside a container, otherwise nothing outside it can connect.
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5010"))
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
