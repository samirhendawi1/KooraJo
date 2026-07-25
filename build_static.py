"""
Build Netlify-friendly seed file: bootstrap.js

Run:
    python build_static.py

This writes window.KOORA seed data so index.html works without Flask.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

from data import AMMAN_CENTER, AREAS, DEFAULT_LOCATION, FACILITIES, GAMES, SPORT

ROOT = Path(__file__).resolve().parent


def open_tonight_estimate(fac: dict) -> int:
    """Rough metric for static seed (real availability still computed in the browser)."""
    # Evening window roughly half the open hours after 17:00
    close = fac["close"]
    open_h = fac["open"]
    evening_hours = max(0, min(close, 24) - max(open_h, 17))
    slots = max(1, int((evening_hours * 60) / fac["slot"] * 0.55))
    return slots


def build_payload() -> dict:
    games = copy.deepcopy(GAMES)
    return {
        "sport": SPORT,
        "facilities": FACILITIES,
        "areas": AREAS,
        "games": games,
        "bookings": [],
        "reservations": [],
        "user": None,
        "ammanCenter": AMMAN_CENTER,
        "defaultLocation": DEFAULT_LOCATION,
        "authenticated": False,
        "metrics": {
            "slotsTonight": sum(open_tonight_estimate(f) for f in FACILITIES),
            "gamesShort": sum(
                1 for g in games if 0 < g["total"] - len(g["players"]) <= 3
            ),
            "venues": len(FACILITIES),
        },
    }


def main() -> None:
    payload = build_payload()
    out = ROOT / "bootstrap.js"
    body = "window.KOORA = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n"
    out.write_text(body, encoding="utf-8")
    print(f"Wrote {out} ({len(payload['facilities'])} venues, {len(payload['games'])} games)")


if __name__ == "__main__":
    main()
