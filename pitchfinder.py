"""
PitchFinder
-----------
Finds free 5-a-side slots for the coming week at our two pitches and prints a
ready-to-paste WhatsApp poll.

The pitches are booked through hireapitch.com. Its calendar quietly loads
availability from a public JSON endpoint (no login needed), so we just ask that
endpoint directly instead of scraping the page.

Run it:   python pitchfinder.py
"""

import json
import sys
import tomllib
import urllib.request
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path

# Windows consoles default to cp1252, which can't print £ or emoji. Force UTF-8.
sys.stdout.reconfigure(encoding="utf-8")

# --- Config -----------------------------------------------------------------

# Editable settings (venues, start hours) live in config.toml next to this file.
CONFIG_PATH = Path(__file__).parent / "config.toml"

API_URL = "https://hireapitch.com/venue/getBookingSlots"


def load_config():
    """Read config.toml and return (venues, allowed_start_hours)."""
    with open(CONFIG_PATH, "rb") as f:
        config = tomllib.load(f)
    return config["venues"], set(config["allowed_start_hours"])


# --- Talking to hireapitch --------------------------------------------------

def fetch_slots(venue, start, end):
    """POST to the booking endpoint and return the list of slot dicts.

    Each slot looks like:
        {"id": 1783799, "start": "2026-06-29T18:00:00", "title": "£75.00", ...}
    where id == 0 means the slot is already booked.
    """
    payload = urllib.parse.urlencode({
        "PlaceID": venue["place_id"],
        "Category": venue["category"],
        "start": start.strftime("%Y-%m-%dT%H:%M:%S"),
        "end": end.strftime("%Y-%m-%dT%H:%M:%S"),
    }).encode()

    request = urllib.request.Request(
        API_URL,
        data=payload,
        headers={
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "PitchFinder (personal use)",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read())


def free_evening_slots(venue, start, end, allowed_hours):
    """Return only the bookable evening slots for one venue, as simple dicts."""
    slots = []
    for slot in fetch_slots(venue, start, end):
        if slot["id"] == 0:            # 0 == already booked
            continue
        when = datetime.fromisoformat(slot["start"])
        if when.weekday() > 4:         # Mon–Fri only (the endpoint's date range is loose)
            continue
        if when.hour not in allowed_hours:
            continue
        slots.append({"venue": venue["name"], "when": when, "price": slot["title"]})
    return slots


# --- Working out which week to look at --------------------------------------

def coming_week():
    """Return (monday, saturday) for the upcoming Mon–Fri block.

    If today is a weekday we've already missed this week's Monday, so we roll
    forward to next Monday. The Saturday end is exclusive, just so the endpoint
    includes all of Friday.
    """
    today = datetime.now().date()
    days_until_monday = (7 - today.weekday()) % 7      # Mon->0, Tue->6, ... Sun->1
    monday = today + timedelta(days=days_until_monday)
    monday_dt = datetime(monday.year, monday.month, monday.day)
    return monday_dt, monday_dt + timedelta(days=5)    # Mon 00:00 .. Sat 00:00


# --- Output -----------------------------------------------------------------

def format_option(slot):
    """e.g. 'Mon 29 Jun · 7pm · Brixton 4G (£75.00)'"""
    when = slot["when"]
    day = when.strftime("%a")                          # Mon, Tue, ...
    date = f"{when.day} {when.strftime('%b')}"         # 29 Jun (no leading zero)
    hour = when.hour % 12 or 12
    suffix = "am" if when.hour < 12 else "pm"
    return f"{day} {date} · {hour}{suffix} · {slot['venue']} ({slot['price']})"


def main():
    venues, allowed_hours = load_config()
    monday, saturday = coming_week()
    friday = monday + timedelta(days=4)

    all_slots = []
    for venue in venues:
        try:
            all_slots.extend(free_evening_slots(venue, monday, saturday, allowed_hours))
        except Exception as error:
            print(f"⚠️  Couldn't fetch {venue['name']}: {error}")

    # Sort by day, then time, then venue so the poll reads chronologically.
    all_slots.sort(key=lambda s: (s["when"], s["venue"]))

    week_label = f"{monday.day} {monday.strftime('%b')}–{friday.day} {friday.strftime('%b')}"
    print()
    print(f"⚽ 5-a-side — week of {monday.strftime('%a')} {week_label}")
    print("(WhatsApp → ➕ → Poll. Paste the question, then each line as an option.)")
    print()

    if not all_slots:
        print("No free 6pm/7pm slots next week at either pitch. 😞")
        return

    print("Question: Which slot works next week?")
    print()
    for slot in all_slots:
        print(format_option(slot))

    if len(all_slots) > 12:
        print()
        print(f"⚠️  {len(all_slots)} options — WhatsApp polls allow max 12, so trim some.")


if __name__ == "__main__":
    main()
