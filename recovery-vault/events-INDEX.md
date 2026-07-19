# Events Recovery Index

Extracted 2026-07-19 from two legacy Supabase projects (`entity_events` tables); matched to LIVE project `mkepugvdlktfsossumox` (`entity` table) by google place ID first, then normalized 10-digit phone. Slug matching was never used. One phone match (March "GT's On The Bay") was dropped as unmatched rather than mis-attributed — the phone number is shared with an unrelated hotel entity in LIVE (name similarity ~0.14).

## Totals

| source | project | rows extracted | net_new | overlap | unmatched | date range |
|---|---|---|---|---|---|---|
| March | adpnhipmdefutkzzltbs | 3289 | 361 | 1321 | 1607 | 2026-04-03 → 2027-05-09 |
| May | xbptmkpbiqzvxptjkfoi | 1899 | 542 | 1319 | 38 | 2026-05-18 → 2026-09-26 |

Status rule: `net_new` = the matched LIVE entity has zero rows in LIVE `entity_events` (keyed on `entity_slug`); `overlap` = the LIVE entity already has events there (dedupe at import time); `unmatched` = no place-ID or phone key match against LIVE. March has 223 rows with a NULL `entity_id` (no venue link in the source DB at all) — these are counted `unmatched`. May's `event_date` is populated on only 247 of 1,899 rows; most May rows are recurring weekly slots keyed by `day_of_week` instead of a specific date. 69 May rows carry an event-level `place_id` that differs from their parent entity's place_id — those were re-matched at the event level (`match_method: place_id_event`).

## Top 15 venues by event count (March)

| venue | events | live_slug | status |
|---|---|---|---|
| Flora-Bama Ole River Grill | 326 | flora-bama-ole-river-grill | overlap |
| (no venue — NULL entity_id) | 223 | — | unmatched |
| Andy D's | 117 | — | unmatched |
| Saucy FuzZ |Tiki & Raw Bar by Barometer | 105 | — | unmatched |
| Tacky Jacks Gulf Shores | 103 | tacky-jacks-gulf-shores | overlap |
| Perdido Beach Resort | 86 | — | unmatched |
| Icehouse Tap Room Gulf Shores | 84 | ice-house-taproom | overlap |
| Cosmo's Restaurant & Bar | 78 | — | unmatched |
| OSO at Bear Point Harbor | 75 | oso-at-bear-point-harbor-2 | overlap |
| Lauria's by the Beach | 71 | lauria-s-by-the-beach | overlap |
| Lulu's | 71 | — | unmatched |
| Flora-Bama Oyster Bar | 70 | flora-bama-oyster-bar | net_new |
| Emerald Waterfront | 67 | — | unmatched |
| Cobalt the Restaurant | 64 | cobalt-the-restaurant | overlap |
| Luna's Eat & Drink | 61 | lunas-eat-and-drink-orange-beach | overlap |
| Juana's Pagodas | 53 | — | unmatched |

## Top 15 venues by event count (May)

| venue | events | live_slug | status |
|---|---|---|---|
| The Flora-Bama Yacht Club | 220 | the-flora-bama-yacht-club | net_new |
| Perdido Beach Resort | 102 | perdido-beach-resort | overlap |
| Ice House Taproom | 100 | ice-house-taproom | overlap |
| Lauria's by the Beach | 98 | lauria-s-by-the-beach | overlap |
| Cosmo's Restaurant & Bar | 92 | cosmo-s-restaurant-bar | net_new |
| GTs On The Bay | 90 | gts-on-the-bay | overlap |
| Bear Point Harbor | 81 | oso-at-bear-point-harbor-orange-beach | net_new |
| Emerald Waterfront Bar and Grill | 76 | emerald-waterfront-bar-and-grill | overlap |
| Luna's Eat & Drink | 74 | lunas-eat-and-drink-orange-beach | overlap |
| Papa Rocco's | 68 | papa-roccos | overlap |
| Tiki & Raw Bar | 66 | tiki-and-raw-bar-orange-beach | overlap |
| Johnny B’s Front Porch, Lillian,Al | 58 | johnny-b-s-front-porch-lillian-al | overlap |
| Flounder's Chowder House | 52 | flounder-s-chowder-house | overlap |
| Bamboo Willie's Beachside Bar on Pensacola Beach | 44 | bamboo-willie-s-beachside-bar-on-pensacola-beach | overlap |
| Angry Crab Shack | 38 | angry-crab-shack | overlap |

## Top 20 artists by event count (both DBs combined)

| artist | events (march) | events (may) | total |
|---|---|---|---|
| Horseshoe Kitty | 54 | 39 | 93 |
| Lefty Collins | 43 | 46 | 89 |
| Top Hat & Jackie | 42 | 46 | 88 |
| Lisa Zanghi | 42 | 32 | 74 |
| Lisa Christian | 41 | 31 | 72 |
| Nigel Dickie | 39 | 28 | 67 |
| Tim Roberts | 41 | 21 | 62 |
| Tyler Ward | 36 | 25 | 61 |
| Buzzcut | 36 | 23 | 59 |
| Strickly Rivers | 35 | 23 | 58 |
| Hippy Jim | 37 | 21 | 58 |
| Salt & Soul | 41 | 16 | 57 |
| Just Roger | 37 | 18 | 55 |
| Tim Roberts Trio | 29 | 25 | 54 |
| Veronica Jean Trio | 34 | 19 | 53 |
| Troy Martin | 25 | 28 | 53 |
| Logan Lassitter | 29 | 23 | 52 |
| Smith & Kern | 29 | 22 | 51 |
| Brent Varner | 30 | 20 | 50 |
| Jesse Duncan | 24 | 22 | 46 |

## Files

- `march/events.json` — all 3,289 March `entity_events` rows
- `may/events.json` — all 1,899 May `entity_events` rows (includes `artist_name`, `venue_location`)
