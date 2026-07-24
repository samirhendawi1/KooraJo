"""
Koora Jo — Flask app with signup/login and persistent store.

Run:
    pip install flask
    python app.py
Open http://127.0.0.1:5000
"""

from __future__ import annotations

import copy
import json
import math
import random
import re
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from data import AMMAN_CENTER, AREAS, DEFAULT_LOCATION, FACILITIES, GAMES, SPORT

ROOT = Path(__file__).resolve().parent
STORE_DIR = ROOT / "store"
STORE_DIR.mkdir(exist_ok=True)

USERS_FILE = STORE_DIR / "users.json"
GAMES_FILE = STORE_DIR / "games.json"
BOOKINGS_FILE = STORE_DIR / "bookings.json"
RESERVATIONS_FILE = STORE_DIR / "reservations.json"

app = Flask(__name__, template_folder=".")
app.secret_key = "koora-jo-change-me-in-production"


# ─── persistence ─────────────────────────────────────────────────────────────

def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return copy.deepcopy(default)
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return copy.deepcopy(default)


def _write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    tmp.replace(path)


def load_store() -> dict[str, Any]:
    users = _read_json(USERS_FILE, [])
    games = _read_json(GAMES_FILE, None)
    if games is None:
        games = copy.deepcopy(GAMES)
        _write_json(GAMES_FILE, games)
    bookings = _read_json(BOOKINGS_FILE, [])
    reservations = _read_json(RESERVATIONS_FILE, [])
    return {
        "users": users,
        "games": games,
        "bookings": bookings,
        "reservations": set(reservations),
    }


STORE = load_store()


def save_users() -> None:
    _write_json(USERS_FILE, STORE["users"])


def save_games() -> None:
    _write_json(GAMES_FILE, STORE["games"])


def save_bookings() -> None:
    _write_json(BOOKINGS_FILE, STORE["bookings"])


def save_reservations() -> None:
    _write_json(RESERVATIONS_FILE, sorted(STORE["reservations"]))


def save_all() -> None:
    save_users()
    save_games()
    save_bookings()
    save_reservations()


# ─── users / auth helpers ────────────────────────────────────────────────────

def initials_for(name: str) -> str:
    parts = [p for p in re.split(r"\s+", name.strip()) if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def public_user(u: dict) -> dict:
    return {
        "id": u["id"],
        "name": u["name"],
        "username": u["username"],
        "email": u["email"],
        "initials": u["initials"],
        "location": u["location"],
    }


def find_user_by_id(uid: str | None) -> dict | None:
    if not uid:
        return None
    return next((u for u in STORE["users"] if u["id"] == uid), None)


def find_user_by_login(login: str) -> dict | None:
    key = login.strip().lower()
    return next(
        (
            u
            for u in STORE["users"]
            if u["username"].lower() == key or u["email"].lower() == key
        ),
        None,
    )


def current_user() -> dict | None:
    return find_user_by_id(session.get("user_id"))


def require_user():
    user = current_user()
    if not user:
        return None, (jsonify({"error": "Please log in first"}), 401)
    return user, None


def face_label(username: str) -> str:
    """Two-letter face label from a username."""
    clean = re.sub(r"[^a-zA-Z0-9]", "", username or "")
    if len(clean) >= 2:
        return clean[:2].upper()
    return (clean or "?").upper()


# ─── venues / slots ──────────────────────────────────────────────────────────

def fac_by_id(fid: str) -> dict | None:
    return next((f for f in FACILITIES if f["id"] == fid), None)


def haversine(a: float, b: float, c: float, d: float) -> float:
    r = math.pi / 180
    d_la = (c - a) * r
    d_lo = (d - b) * r
    x = math.sin(d_la / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin(d_lo / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))


def fnv_hash(s: str) -> float:
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h / 4294967295


def today_iso() -> str:
    return date.today().isoformat()


def reservation_key(fac_id: str, day: str, start: int) -> str:
    return f"{fac_id}|{day}|{start}"


def slots_for(fac: dict, day: str) -> list[dict]:
    d = datetime.strptime(day + "T12:00:00", "%Y-%m-%dT%H:%M:%S")
    js_dow = (d.weekday() + 1) % 7
    now = datetime.now()
    now_m = now.hour * 60 + now.minute
    is_today = day == today_iso()
    out = []
    m = fac["open"] * 60
    while m + fac["slot"] <= fac["close"] * 60:
        h = m // 60
        peak = 17 <= h < 23
        occ = 0.44 if peak else 0.16
        if js_dow in (4, 5):
            occ += 0.11
        sim_booked = fnv_hash(f"{fac['id']}|{day}|{m}") < occ
        real_booked = reservation_key(fac["id"], day, m) in STORE["reservations"]
        booked = sim_booked or real_booked
        past = is_today and m <= now_m
        price = fac["price"] * (1.45 if peak else 1)
        if js_dow == 5 and h < 14:
            price *= 0.75
        out.append(
            {
                "start": m,
                "end": m + fac["slot"],
                "peak": peak,
                "booked": booked,
                "past": past,
                "price": round(price * 2) / 2,
            }
        )
        m += fac["slot"]
    return out


def open_tonight(fac: dict) -> int:
    return sum(
        1
        for s in slots_for(fac, today_iso())
        if not s["booked"] and not s["past"] and s["start"] >= 17 * 60
    )


def open_today(fac: dict) -> int:
    return sum(1 for s in slots_for(fac, today_iso()) if not s["booked"] and not s["past"])


def gate_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "KJ-" + "".join(random.choice(alphabet) for _ in range(4))


def fmt_d(km: float) -> str:
    return f"{round(km * 1000)} m" if km < 1 else f"{km:.1f} km"


def user_bookings(user: dict) -> list[dict]:
    return [b for b in STORE["bookings"] if b.get("userId") == user["id"]]


def bootstrap_payload(user: dict | None = None) -> dict:
    bookings = user_bookings(user) if user else []
    return {
        "sport": SPORT,
        "facilities": FACILITIES,
        "areas": AREAS,
        "games": STORE["games"],
        "bookings": bookings,
        "reservations": sorted(STORE["reservations"]),
        "user": public_user(user) if user else None,
        "ammanCenter": AMMAN_CENTER,
        "defaultLocation": DEFAULT_LOCATION,
        "authenticated": bool(user),
        "metrics": {
            "slotsTonight": sum(open_tonight(f) for f in FACILITIES),
            "gamesShort": sum(
                1
                for g in STORE["games"]
                if 0 < g["total"] - len(g["players"]) <= 3
            ),
            "venues": len(FACILITIES),
        },
    }


# ─── chat ────────────────────────────────────────────────────────────────────

def chat_response(message: str) -> dict:
    q = message.lower().strip()

    if re.match(r"^(hi|hello|hey|hiya|yo|sup|marhaba|مرحبا|أهلا|اهلا)", q):
        return {
            "text": "Hey there! How can I help you with your next game? You can ask about venues, prices, availability, or booking.",
            "chips": ["Football venues", "Padel courts", "Basketball halls", "What's open tonight?"],
        }
    if re.search(r"(thank|thanks|شكر)", q):
        return {
            "text": "You're welcome! Let me know if you need anything else. Enjoy your game!",
            "chips": ["Find another venue", "Check my bookings"],
        }

    if re.search(r"(football|soccer|كرة قدم)", q) and re.search(r"(venue|field|pitch|where|find|show|list|book)", q):
        fb = [f for f in FACILITIES if f["sport"] == "football"]
        lines = [f"We have <b>{len(fb)} football venues</b> in Amman:<br><br>"]
        for f in fb:
            lines.append(
                f"• <b>{f['name']}</b> ({f['area']}) — {f['price']} JD/hr, {open_today(f)} slots open today<br>"
            )
        lines.append("<br>Want to book one? Just tell me which venue or area you prefer.")
        return {"text": "".join(lines), "chips": [f"Book {f['name'].split()[0]}" for f in fb[:3]]}

    if "padel" in q and re.search(r"(venue|court|where|find|show|list|book)", q):
        pd = [f for f in FACILITIES if f["sport"] == "padel"]
        lines = [f"We have <b>{len(pd)} padel venues</b>:<br><br>"]
        for f in pd:
            lines.append(
                f"• <b>{f['name']}</b> ({f['area']}) — {f['price']} JD/90min, {open_today(f)} slots today<br>"
            )
        return {"text": "".join(lines), "chips": [f"Book {f['name'].split()[0]}" for f in pd[:3]]}

    if re.search(r"(basketball|basket|hoops)", q) and re.search(r"(venue|court|hall|where|find|show|list|book)", q):
        bb = [f for f in FACILITIES if f["sport"] == "basketball"]
        lines = [f"We have <b>{len(bb)} basketball venues</b>:<br><br>"]
        for f in bb:
            lines.append(
                f"• <b>{f['name']}</b> ({f['area']}) — {f['price']} JD/hr, {open_today(f)} slots today<br>"
            )
        return {"text": "".join(lines), "chips": [f"Book {f['name'].split()[0]}" for f in bb[:2]]}

    if re.search(r"(cheap|lowest|budget|affordable|cheapest|ارخص)", q):
        top = sorted(FACILITIES, key=lambda f: f["price"])[:3]
        lines = ["Here are the <b>most affordable venues</b>:<br><br>"]
        for f in top:
            s = SPORT[f["sport"]]
            lines.append(f"• <b>{f['name']}</b> — <b>{f['price']} JD</b>/{s['unit']} ({s['label']})<br>")
        return {
            "text": "".join(lines),
            "chips": ["Book " + " ".join(f["name"].split()[:2]) for f in top],
        }

    if re.search(r"(best|top|highest.*rat|recommend)", q):
        top = sorted(FACILITIES, key=lambda f: f["rating"], reverse=True)[:3]
        lines = ["Our <b>top-rated venues</b>:<br><br>"]
        for f in top:
            lines.append(
                f"• <b>{f['name']}</b> — ★ {f['rating']} ({f['reviews']} reviews) · {SPORT[f['sport']]['label']}<br>"
            )
        return {
            "text": "".join(lines),
            "chips": ["Book " + " ".join(f["name"].split()[:2]) for f in top],
        }

    if re.search(r"(tonight|open|available|free|متاح)", q):
        open_list = sorted(
            [f for f in FACILITIES if open_tonight(f) > 0],
            key=open_tonight,
            reverse=True,
        )
        if not open_list:
            return {
                "text": "Looks like everything is booked tonight! Try checking tomorrow's availability.",
                "chips": ["Show all venues", "Check tomorrow"],
            }
        lines = [f"<b>{len(open_list)} venues</b> have slots open tonight:<br><br>"]
        for f in open_list[:5]:
            lines.append(f"• <b>{f['name']}</b> — {open_tonight(f)} evening slots · {f['price']} JD<br>")
        return {
            "text": "".join(lines),
            "chips": [f"Book {open_list[0]['name'].split()[0]}", "Show all", "Filter by sport"],
        }

    if re.search(r"(how|what).*(book|reserve|حجز)", q):
        return {
            "text": (
                "Booking a full field is easy:<br><br>"
                "1. Go to the <b>Book field</b> tab<br>"
                "2. Pick a venue and click <b>Book full field</b><br>"
                "3. Choose your date and time slot<br>"
                "4. Set the number of players<br>"
                "5. Confirm — you'll get a gate code instantly<br><br>"
                'You can also toggle <b>"List as drop-in"</b> to let others join and split the cost!'
            ),
            "chips": ["Browse venues", "What's available tonight?"],
        }

    if re.search(r"(drop.?in|join|game|spot|لعبة)", q):
        open_games = [g for g in STORE["games"] if g["total"] - len(g["players"]) > 0]
        if not open_games:
            return {
                "text": "No open drop-in games right now. You can book a full field and list it as a drop-in so others can join!",
                "chips": ["Book a field"],
            }
        lines = [f"There are <b>{len(open_games)} games</b> looking for players:<br><br>"]
        for g in open_games[:4]:
            f = fac_by_id(g["fac"])
            left = g["total"] - len(g["players"])
            lines.append(
                f"• <b>{g['host']}'s {SPORT[g['sport']]['label'].lower()}</b> at {f['name']} — "
                f"{left} spot{'s' if left > 1 else ''} left, {g['perHead']} JD<br>"
            )
        return {"text": "".join(lines), "chips": ["View drop-in games", "Book my own field"]}

    if re.search(r"(indoor|covered|مغطى)", q):
        ind = [f for f in FACILITIES if f["indoor"]]
        lines = [f"We have <b>{len(ind)} indoor venues</b>:<br><br>"]
        for f in ind:
            lines.append(
                f"• <b>{f['name']}</b> ({SPORT[f['sport']]['label']}) — {f['price']} JD · {f['area']}<br>"
            )
        return {
            "text": "".join(lines),
            "chips": ["Book " + " ".join(f["name"].split()[:2]) for f in ind],
        }

    if re.search(r"(cancel|refund|الغاء)", q):
        return {
            "text": "You can cancel any booking up to <b>4 hours</b> before start time for a full refund. Go to <b>My bookings</b> and hit the Cancel button on your pass.",
            "chips": ["View my bookings"],
        }

    if re.search(r"(price|cost|how much|كم|سعر)", q):
        sorted_f = sorted(FACILITIES, key=lambda f: f["price"])
        return {
            "text": (
                f"Prices range from <b>{sorted_f[0]['price']} JD</b> to "
                f"<b>{sorted_f[-1]['price']} JD</b> per session.<br><br>"
                "Peak hours (17:00–23:00) cost about 45% more. Friday mornings get a 25% discount!<br><br>"
                "A 1 JD booking fee is added to every reservation."
            ),
            "chips": ["Cheapest venues", "Best rated", "What's open tonight?"],
        }

    area_match = next((a for a in AREAS if a["name"].lower() in q), None)
    if area_match:
        near = sorted(
            FACILITIES,
            key=lambda f: haversine(area_match["lat"], area_match["lng"], f["lat"], f["lng"]),
        )[:3]
        lines = [f"Venues closest to <b>{area_match['name']}</b>:<br><br>"]
        for f in near:
            d = haversine(area_match["lat"], area_match["lng"], f["lat"], f["lng"])
            lines.append(
                f"• <b>{f['name']}</b> — {fmt_d(d)} away · {SPORT[f['sport']]['label']} · {f['price']} JD<br>"
            )
        return {
            "text": "".join(lines),
            "chips": ["Book " + " ".join(f["name"].split()[:2]) for f in near],
        }

    fac_match = next(
        (f for f in FACILITIES if " ".join(f["name"].lower().split()[:2]) in q),
        None,
    )
    if fac_match:
        free = open_today(fac_match)
        return {
            "text": (
                f"<b>{fac_match['name']}</b><br>{fac_match['area']} · {fac_match['surface']} · ★ {fac_match['rating']}<br>"
                f"<b>{fac_match['price']} JD</b> / {SPORT[fac_match['sport']]['unit']}<br>"
                f"{free} slots available today<br><br>Amenities: {', '.join(fac_match['tags'])}"
            ),
            "chips": ["Book this venue", "Show availability", "Compare prices"],
        }

    if re.search(r"(football|padel|basketball|book|venue|field|pitch|court)", q):
        return {
            "text": (
                "I can help with that! Could you be a bit more specific? For example:<br>"
                '• "Find me a football field near Abdoun"<br>'
                '• "What\'s the cheapest padel court?"<br>'
                '• "Show indoor basketball venues"'
            ),
            "chips": ["Football venues", "Padel courts", "Basketball halls", "What's available tonight?"],
        }

    return {
        "text": (
            "I'm not sure about that, but I can help with:<br>"
            "• Finding venues by sport, area, or price<br>"
            "• Checking tonight's availability<br>"
            "• Explaining how booking works<br>"
            "• Showing drop-in games you can join<br><br>"
            "What would you like to know?"
        ),
        "chips": ["Find a venue", "What's open tonight?", "How does booking work?", "Drop-in games"],
    }


# ─── routes ──────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    user = current_user()
    return render_template(
        "index.html",
        bootstrap=bootstrap_payload(user),
        user=public_user(user) if user else None,
    )


@app.post("/api/signup")
def api_signup():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    username = (body.get("username") or "").strip().lower()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    area_name = (body.get("area") or DEFAULT_LOCATION["name"]).strip()

    if len(name) < 2:
        return jsonify({"error": "Enter your full name"}), 400
    if not re.fullmatch(r"[a-z0-9_]{3,20}", username):
        return jsonify({"error": "Username must be 3–20 characters (letters, numbers, _)"}), 400
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify({"error": "Enter a valid email"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400
    if find_user_by_login(username) or find_user_by_login(email):
        return jsonify({"error": "Username or email already registered"}), 409

    area = next((a for a in AREAS if a["name"] == area_name), None) or DEFAULT_LOCATION
    user = {
        "id": f"u{int(time.time() * 1000)}",
        "name": name,
        "username": username,
        "email": email,
        "password_hash": generate_password_hash(password),
        "initials": initials_for(name),
        "location": {"name": area["name"], "lat": area["lat"], "lng": area["lng"]},
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    STORE["users"].append(user)
    save_users()
    session["user_id"] = user["id"]
    return jsonify({"user": public_user(user), "bootstrap": bootstrap_payload(user)})


@app.post("/api/login")
def api_login():
    body = request.get_json(silent=True) or {}
    login = (body.get("login") or "").strip()
    password = body.get("password") or ""
    user = find_user_by_login(login)
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Wrong username/email or password"}), 401
    session["user_id"] = user["id"]
    return jsonify({"user": public_user(user), "bootstrap": bootstrap_payload(user)})


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
def api_me():
    user = current_user()
    if not user:
        return jsonify({"authenticated": False, "user": None})
    return jsonify({"authenticated": True, "user": public_user(user), "bootstrap": bootstrap_payload(user)})


@app.post("/api/location")
def api_location():
    user, err = require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    lat = body.get("lat")
    lng = body.get("lng")
    if lat is None or lng is None:
        return jsonify({"error": "Missing coordinates"}), 400
    user["location"] = {"name": name or "my location", "lat": float(lat), "lng": float(lng)}
    save_users()
    return jsonify({"user": public_user(user)})


@app.post("/api/chat")
def api_chat():
    user, err = require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    text = (body.get("message") or "").strip()
    if not text:
        return jsonify({"error": "Empty message"}), 400
    return jsonify(chat_response(text))


@app.post("/api/book")
def api_book():
    user, err = require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    fac = fac_by_id(body.get("facId", ""))
    if not fac:
        return jsonify({"error": "Unknown facility"}), 404

    start = int(body["start"])
    end = int(body["end"])
    day = body["date"]
    players = int(body.get("players", 10))
    share = bool(body.get("share", False))
    price = float(body["price"])
    fee = 1
    total = price + fee

    key = reservation_key(fac["id"], day, start)
    if key in STORE["reservations"]:
        return jsonify({"error": "That slot was just taken — pick another time"}), 409

    # Also block if simulated occupancy would mark it booked
    slot = next((s for s in slots_for(fac, day) if s["start"] == start), None)
    if not slot or slot["booked"] or slot["past"]:
        return jsonify({"error": "That slot is no longer available"}), 409

    STORE["reservations"].add(key)
    booking = {
        "id": f"b{int(time.time() * 1000)}",
        "userId": user["id"],
        "username": user["username"],
        "kind": "court",
        "sport": fac["sport"],
        "facId": fac["id"],
        "date": day,
        "start": start,
        "end": end,
        "total": total,
        "players": players,
        "code": gate_code(),
        "cancelled": False,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    STORE["bookings"].insert(0, booking)

    if share:
        today = date.today()
        target = datetime.strptime(day, "%Y-%m-%d").date()
        off = (target - today).days
        STORE["games"].insert(
            0,
            {
                "id": f"g{int(time.time() * 1000)}",
                "sport": fac["sport"],
                "fac": fac["id"],
                "host": user["name"].split()[0],
                "hostUsername": user["username"],
                "players": [user["username"]],
                "dayOffset": off,
                "hour": start // 60,
                "min": start % 60,
                "dur": fac["slot"],
                "total": players,
                "perHead": round((total / players) * 2) / 2,
                "level": "Mixed",
                "note": "Open spots. Pay your share at the gate.",
                "mine": True,
                "ownerId": user["id"],
            },
        )

    save_bookings()
    save_reservations()
    save_games()

    return jsonify(
        {
            "booking": booking,
            "toast": (
                "Booked full field & listed as a drop-in game"
                if share
                else f"Full field booked · {booking['code']}"
            ),
            "games": STORE["games"],
            "bookings": user_bookings(user),
            "reservations": sorted(STORE["reservations"]),
            "bootstrap": bootstrap_payload(user),
        }
    )


@app.post("/api/join")
def api_join():
    user, err = require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    game_id = body.get("gameId")
    game = next((g for g in STORE["games"] if g["id"] == game_id), None)
    if not game:
        return jsonify({"error": "Game not found"}), 404
    if len(game["players"]) >= game["total"]:
        return jsonify({"error": "Game is full"}), 400
    if user["username"] in game["players"]:
        return jsonify({"error": "You're already in this game"}), 409

    game["players"].append(user["username"])
    fac = fac_by_id(game["fac"])
    d = date.today() + timedelta(days=game["dayOffset"])
    booking = {
        "id": f"b{int(time.time() * 1000)}",
        "userId": user["id"],
        "username": user["username"],
        "kind": "game",
        "gameId": game["id"],
        "sport": game["sport"],
        "facId": fac["id"],
        "date": d.isoformat(),
        "start": game["hour"] * 60 + game["min"],
        "end": game["hour"] * 60 + game["min"] + game["dur"],
        "total": game["perHead"],
        "players": 1,
        "host": game["host"],
        "code": gate_code(),
        "cancelled": False,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    STORE["bookings"].insert(0, booking)
    save_games()
    save_bookings()
    return jsonify(
        {
            "booking": booking,
            "toast": f"You're in {game['host']}'s game",
            "games": STORE["games"],
            "bookings": user_bookings(user),
            "bootstrap": bootstrap_payload(user),
        }
    )


@app.post("/api/cancel")
def api_cancel():
    user, err = require_user()
    if err:
        return err
    body = request.get_json(silent=True) or {}
    bid = body.get("bookingId")
    booking = next(
        (b for b in STORE["bookings"] if b["id"] == bid and b.get("userId") == user["id"]),
        None,
    )
    if not booking:
        return jsonify({"error": "Booking not found"}), 404
    if booking["cancelled"]:
        return jsonify({"error": "Already cancelled"}), 400

    booking["cancelled"] = True
    if booking["kind"] == "court":
        key = reservation_key(booking["facId"], booking["date"], booking["start"])
        STORE["reservations"].discard(key)
        save_reservations()
        # Remove drop-in game created with this booking if still owned
        STORE["games"] = [
            g
            for g in STORE["games"]
            if not (
                g.get("ownerId") == user["id"]
                and g.get("fac") == booking["facId"]
                and g.get("hour") == booking["start"] // 60
                and g.get("min") == booking["start"] % 60
            )
        ]
        save_games()
    elif booking["kind"] == "game":
        game = next((g for g in STORE["games"] if g["id"] == booking.get("gameId")), None)
        if game and user["username"] in game["players"]:
            game["players"] = [p for p in game["players"] if p != user["username"]]
            save_games()

    save_bookings()
    return jsonify(
        {
            "bookings": user_bookings(user),
            "games": STORE["games"],
            "reservations": sorted(STORE["reservations"]),
            "bootstrap": bootstrap_payload(user),
            "toast": "Booking cancelled · full refund issued",
        }
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)
