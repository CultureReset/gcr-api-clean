# Yelp Orange Beach Collector

Two-phase scraper for Orange Beach, AL listings on Yelp:

1. **Search phase** - walks all 11 categories below, paginating through
   results, and builds a deduplicated master list of businesses.
2. **Detail phase** - visits every business's own Yelp page and pulls the
   full profile: phone, external website, full address, lat/lng, price
   level, full category list, weekly hours, rating/review count, a
   representative photo, and description.

Categories covered: Restaurants, Tours, Rentals, Things to Do, Things to Do
with Teenagers, Food, Delivery Food, Fishing, Condos for Rent, Activities,
Hotels.

## Install

```bash
python -m pip install -r requirements.txt
python -m playwright install chromium
```

## Run

```bash
python yelp_orange_beach_collector.py
```

A Chromium browser opens and uses a persistent local profile. This runs both
phases: search collection, then a detail-page visit for every unique
business found.

If Yelp asks you to sign in or verify that you are human, complete that step
manually in the opened browser and then press Enter in the terminal. This
can happen on both the search phase and the detail phase, since the detail
phase visits hundreds of individual pages.

**Do not use `--headless`** for the first run — Yelp may require manual
verification, which headless mode cannot satisfy.

## Outputs

Written to `--output` (default `yelp_orange_beach_export/`):

- `01_yelp_raw_search_results.csv` / `.json` — every listing as it appeared
  in each search category (a business can appear more than once).
- `02_master_businesses.csv` / `.json` — deduplicated business list from the
  search phase.
- `03_business_details.csv` / `.json` — full per-business profile from the
  detail phase, one row per business in the master list.
- `raw_html/` — HTML snapshot of every search page and every business page
  visited, for debugging/auditing.
- `browser_profile/` — persistent Chromium profile (keeps you signed in /
  verified between runs).

## Options

```bash
python yelp_orange_beach_collector.py \
  --output yelp_orange_beach_export \
  --max-pages 30 \
  --page-size 10 \
  --delay 2.5
```

- `--skip-search` — skip phase 1 and reuse an existing
  `02_master_businesses.json` in `--output` (resume into the detail phase
  only).
- `--search-only` — run phase 1 only; skip visiting individual business
  pages.
- `--max-businesses N` — limit the detail phase to the first N businesses.
  Useful for a quick test run before doing the full ~hundreds of pages.

Example: do the search phase, review the master list, then run the detail
phase separately:

```bash
python yelp_orange_beach_collector.py --search-only
python yelp_orange_beach_collector.py --skip-search
```
