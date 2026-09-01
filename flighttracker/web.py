"""Local dashboard: `python -m flighttracker.web` then open http://localhost:5010"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from pathlib import Path

import json

from flask import Flask, Response, jsonify, request, send_from_directory

from . import chat as chat_mod
from . import db
from .config import load_config
from .scoring import convenience_adjustment, day_adjustment

STATIC_DIR = Path(__file__).resolve().parent / "static"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


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
                    "effective": round(r["price"] + adj, 2),
                    "label": label,
                    "source": r["source"],
                }
            )
        return jsonify({"flights": out, "last_captured": last_captured,
                        "currency": cfg.currency})
    finally:
        conn.close()


TRIP_CAP = 2000


def _matches_when(label: str, when: str) -> bool:
    if not when:
        return True
    if when == "weekend":
        return "weekend" in label
    if when == "fri":
        return "fri evening" in label
    if when == "convenient":
        return "weekend" in label or "fri evening" in label
    if when == "weekday":
        return "weekday" in label or "work hours" in label
    return True


def _package_combos(min_nights, max_nights, airport, when, direct_only,
                    max_price, cfg) -> list[dict]:
    """Luxair round trips, shaped like the paired ones so the UI can mix them.

    These are non-stop and quoted whole, but carry no departure times, so they
    are scored on the day of week only (see scoring.day_adjustment)."""
    conn = db.connect()
    try:
        rows = db.latest_packages(conn)
    finally:
        conn.close()

    out = []
    for r in rows:
        if airport and r["origin"] != airport and r["destination"] != airport:
            continue
        if not (min_nights <= r["nights"] <= max_nights):
            continue
        if max_price is not None and r["price"] > max_price:
            continue
        try:
            out_day = date.fromisoformat(r["out_date"])
        except ValueError:
            continue
        ret_day = out_day + timedelta(days=r["nights"])
        out_adj, out_label = day_adjustment(out_day, cfg.scoring)
        ret_adj, ret_label = day_adjustment(ret_day, cfg.scoring)
        if not _matches_when(out_label, when):
            continue
        airline = "Luxair"
        out.append({
            "out": {
                "origin": r["origin"], "destination": r["destination"],
                "departure": f"{out_day.isoformat()}T00:00:00",
                "date_only": True, "airline": airline, "stops": 0,
                "price": None, "adjustment": out_adj, "label": out_label,
                "source": "luxair",
            },
            "ret": {
                "origin": r["destination"], "destination": r["origin"],
                "departure": f"{ret_day.isoformat()}T00:00:00",
                "date_only": True, "airline": airline, "stops": 0,
                "price": None, "adjustment": ret_adj, "label": ret_label,
                "source": "luxair",
            },
            "nights": r["nights"],
            "same_airport": True,
            "package": True,
            "price": r["price"],
            "adjustment": out_adj + ret_adj,
            "effective": round(r["price"] + out_adj + ret_adj, 2),
        })
    return out


@app.get("/api/trips")
def trips():
    """Pair outbound legs (X->ALC) with return legs (ALC->X) into scored round
    trips. Filtering happens here, not client-side: there are tens of thousands
    of pairings, so a global top-N would hide every LUX trip behind cheaper
    Ryanair ones. We filter first, then return the best TRIP_CAP."""
    min_nights = int(request.args.get("min_nights", 1))
    max_nights = int(request.args.get("max_nights", 21))
    airport = request.args.get("airport", "").upper()
    when = request.args.get("when", "")
    same_only = request.args.get("same_airport") == "1"
    direct_only = request.args.get("direct") == "1"
    max_price_raw = request.args.get("max_price", "")
    max_price = float(max_price_raw) if max_price_raw else None
    cfg = load_config()
    conn = db.connect()
    try:
        rows = db.latest_snapshot(conn)
    finally:
        conn.close()

    outbounds, returns, last_captured = [], [], None
    for r in rows:
        try:
            dep = datetime.fromisoformat(r["departure"])
        except ValueError:
            continue
        adj, label = convenience_adjustment(dep, cfg.scoring)
        leg = {
            "origin": r["origin"], "destination": r["destination"],
            "departure": r["departure"], "airline": r["airline"],
            "stops": r["stops"],
            "price": r["price"], "adjustment": adj, "label": label,
            "source": r["source"], "_dep": dep,
        }
        if last_captured is None or r["captured_at"] > last_captured:
            last_captured = r["captured_at"]
        if direct_only and r["stops"]:
            continue
        if r["destination"] == "ALC":
            if airport and r["origin"] != airport:
                continue
            if not _matches_when(label, when):
                continue
            outbounds.append(leg)
        elif r["origin"] == "ALC":
            if airport and r["destination"] != airport:
                continue
            returns.append(leg)

    combos = []
    for out in outbounds:
        for ret in returns:
            nights = (ret["_dep"].date() - out["_dep"].date()).days
            if nights < min_nights or nights > max_nights:
                continue
            if nights == 0 and ret["_dep"] <= out["_dep"]:
                continue
            if same_only and out["origin"] != ret["destination"]:
                continue
            if max_price is not None and out["price"] + ret["price"] > max_price:
                continue
            combos.append(
                {
                    "out": {k: v for k, v in out.items() if k != "_dep"},
                    "ret": {k: v for k, v in ret.items() if k != "_dep"},
                    "nights": nights,
                    "same_airport": out["origin"] == ret["destination"],
                    "price": round(out["price"] + ret["price"], 2),
                    "adjustment": out["adjustment"] + ret["adjustment"],
                    "effective": round(
                        out["price"] + ret["price"]
                        + out["adjustment"] + ret["adjustment"], 2
                    ),
                }
            )
    combos.extend(_package_combos(
        min_nights, max_nights, airport, when, direct_only, max_price, cfg))
    combos.sort(key=lambda c: c["effective"])
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
                fav["legs"] = [{
                    "origin": r["out_origin"], "destination": r["out_destination"],
                    "departure": r["out_departure"], "date_only": True,
                    "airline": "Luxair", "stops": 0,
                    "price": now["price"] if now else None,
                    "low": ext["lo"] if ext else None,
                    "high": ext["hi"] if ext else None,
                    "adjustment": adj, "label": label,
                }, {
                    "origin": r["out_destination"], "destination": r["out_origin"],
                    "departure": r["ret_departure"], "date_only": True,
                    "airline": "Luxair", "stops": 0, "price": None,
                    "low": None, "high": None, "adjustment": 0, "label": "",
                }]
                fav["price_now"] = now["price"] if now else None
                fav["package"] = True
                fav["delta"] = (round(fav["price_now"] - fav["price_at_save"], 2)
                                if fav["price_at_save"] and fav["price_now"] else None)
                fav["key"] = db.favorite_key(fav)
                out.append(fav)
                continue

            total_now = 0.0
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
                fav["legs"].append({
                    "origin": origin, "destination": dest, "departure": dep,
                    "airline": now["airline"] if now else None,
                    "stops": now["stops"] if now else 0,
                    "price": price,
                    "low": ext["lo"] if ext else None,
                    "high": ext["hi"] if ext else None,
                    "adjustment": adj, "label": label,
                })
            fav["price_now"] = round(total_now, 2) if total_now else None
            if fav["price_at_save"] and fav["price_now"]:
                fav["delta"] = round(fav["price_now"] - fav["price_at_save"], 2)
            else:
                fav["delta"] = None
            fav["key"] = db.favorite_key(fav)
            out.append(fav)
        return jsonify({"favorites": out})
    finally:
        conn.close()


@app.get("/api/calendar")
def calendar():
    """Cheapest fare per day per direction, plus the best round trip starting
    each day — enough for a month grid the user can scan."""
    cfg = load_config()
    conn = db.connect()
    try:
        rows = db.daily_minima(conn)
    finally:
        conn.close()

    out_days: dict[str, float] = {}
    ret_days: dict[str, float] = {}
    airports: dict[str, set] = {"out": set(), "ret": set()}
    airport = request.args.get("airport", "").upper()
    for r in rows:
        if r["destination"] == "ALC":
            if airport and r["origin"] != airport:
                continue
            airports["out"].add(r["origin"])
            d = out_days
        elif r["origin"] == "ALC":
            if airport and r["destination"] != airport:
                continue
            airports["ret"].add(r["destination"])
            d = ret_days
        else:
            continue
        day = r["day"]
        if day not in d or r["price"] < d[day]:
            d[day] = r["price"]
    return jsonify({
        "outbound": [{"day": k, "price": round(v, 2)} for k, v in sorted(out_days.items())],
        "inbound": [{"day": k, "price": round(v, 2)} for k, v in sorted(ret_days.items())],
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
    app.run(host="127.0.0.1", port=5010, debug=False)


if __name__ == "__main__":
    main()
