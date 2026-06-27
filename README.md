# PitchFinder ⚽

Finds free 5-a-side slots for the coming week at our two pitches and prints a
ready-to-paste WhatsApp poll.

The pitches are booked via [hireapitch.com](https://hireapitch.com). Its
calendar loads availability from a public JSON endpoint (no login needed), so
this just queries that endpoint directly — no scraping, no browser.

## Run it

```
python pitchfinder.py
```

No dependencies — standard library only (Python 3.9+).

Copy the output into WhatsApp: tap ➕ → **Poll**, paste the question, then paste
each slot line as an option.

## What it does

- Looks at the **upcoming Mon–Fri** (rolls to next week if this week's Monday has passed).
- Keeps only **free** slots starting at **6pm or 7pm**.
- Lists them chronologically with venue and price.

## Tweaking it

Everything adjustable lives at the top of `pitchfinder.py`:

- `VENUES` — add/remove pitches. Each needs a `place_id`, found in a venue
  page's source as `<input id="ID" value="...">`.
- `ALLOWED_START_HOURS` — change the kickoff times (24h, e.g. `{18, 19, 20}`).
