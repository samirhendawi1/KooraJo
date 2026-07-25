"""
Seed data for Koora Jo.

Edit these JSON files to change venues, areas, sports, or drop-in games:
  data/facilities.json  ← add / edit pitches & courts (id, name, price, lat/lng, …)
  data/areas.json       ← home areas for the location picker
  data/sports.json      ← sport labels / colors
  data/games.json       ← seeded drop-in games
  data/meta.json        ← map defaults

Then regenerate the Netlify seed:
  python build_static.py
"""

from __future__ import annotations

import json
from pathlib import Path

_DIR = Path(__file__).resolve().parent


def _load(name: str):
    with (_DIR / name).open(encoding="utf-8") as f:
        return json.load(f)


SPORT = _load("sports.json")
FACILITIES = _load("facilities.json")
AREAS = _load("areas.json")
GAMES = _load("games.json")
_META = _load("meta.json")
AMMAN_CENTER = _META["ammanCenter"]
DEFAULT_LOCATION = _META["defaultLocation"]

__all__ = [
    "SPORT",
    "FACILITIES",
    "AREAS",
    "GAMES",
    "AMMAN_CENTER",
    "DEFAULT_LOCATION",
]
