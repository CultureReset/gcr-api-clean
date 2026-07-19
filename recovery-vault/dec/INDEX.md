# Dec (gcr_businesses) Recovery Vault Index

Source project: lvmsmjlallptylonscat (Dec snapshot). 946 rows in `gcr_businesses` (729 place_ids, 728 google_places_data payloads, 846 phones).
Matching vs live entity table: place_id first (420), then normalized phone (120); unmatched 406.

## Files

- menus.json — 61 businesses with parseable Google menu blobs, 7514 items (name/price/section/description). Statuses: net_new 27 (matched live business with zero live menu_items), overlap 12, unmatched 22. Widened scope: ALL 61 blobs extracted (60 array-form + 1 nested dict form, Cobalt the Restaurant).
- place-id-backfill.json — 72 records: live entities that LACK google_place_id, phone-matched to a Dec business that has one. 13 flagged weak_match (name similarity < 0.5) — review before applying. (Prior audit estimated ~92; live has likely gained place IDs since, current residual is 72.)
- hours-residual.json — 14 opening_hours payloads (weekday_text + parsed per-day opens/closes) for matched live entities with zero entity_hours rows, + 1 record type:"phone" (Pink Pelican Art Gallery phone 2512190050; its live entity has no phone). Duplicate-slug and weak phone matches flagged. (Prior audit estimated ~8; residual computed against current live hours = 14.)
- net-new-candidates.json — 181 tourism-plausible unmatched Dec businesses with a place_id or phone (full record incl. place_id, phone, address, types, category).

## Exclusions from net-new-candidates

Of 406 unmatched rows: 168 excluded as junk (medical/dental/health 119, finance/bank/atm 66, church 24, car repair/wash 23, laundry 11, beauty/hair, gas, insurance, storage, etc. — matched on Google types/category keywords), and 57 excluded for having neither place_id nor phone (unmatchable).

## Net-new menu businesses (matched, live menu empty)

- The Flora-Bama Yacht Club -> the-flora-bama-yacht-club (74 items)
- The Gulf Bowl Bowling Alley & Captain's Choice Seafood Restaurant -> the-gulf-bowl-bowling-alley-captain-s-choice-seafood-restaurant (135 items)
- DRI Gulf Coast -> dri-gulf-coast (135 items)
- Cotton's Restaurant -> cotton-s-restaurant (276 items)
- De Soto's Seafood Kitchen -> de-soto-s-seafood-kitchen (188 items)
- Gulf Shores / Pensacola West KOA Holiday -> gulf-shores-pensacola-west-koa-holiday (135 items)
- HOTWORX - Gulf Shores AL -> hotworx-gulf-shores (135 items)
- 10th Planet Jiu Jitsu Gulf Shores -> 10th-planet-jiu-jitsu-gulf-shores (135 items)
- Salon Thirty-One Gulf Shores -> salon-thirty-one-gulf-shores (135 items)
- Gulf Shores CrossFit -> gulf-shores-crossfit (135 items)
- Jellystone Park™ Alabama Gulf Coast -> jellystone-park-alabama-gulf-coast-gDfYSs (135 items)
- Peaches N Clean Gulf Shores -> peaches-n-clean-carpet-cleaning (135 items)
- Gulf Coast Rental Co -> gulf-coast-rental-co (135 items)
- Gulf Shores Massage Therapy -> gulf-shores-massage-therapy (135 items)
- Gulf Shores Slingshot Rentals -> gulf-shores-slingshot-rentals (135 items)
- Coastal Coffee Co. -> coastal-coffee-co (237 items)
- Gulf Shores Methodist Church -> gulf-shores-methodist-church (135 items)
- Wolf Bay Restaurant at Orange Beach -> wolf-bay-restaurant-at-orange-beach (26 items)
- Lickin Good Donuts & Kolaches -Gulf Shores -> lickin-good-donuts-kolaches-gulf-shores (135 items)
- Gulf Shores Post Office -> gulf-shores-post-office (135 items)
- 132 Gulf Ct Parking -> 132-gulf-ct-parking (135 items)
- Lavish Nail Gulf Shores. -> lavish-nail-gulf-shores-H9gcbU (135 items)
- Gulf to Go -> gulf-to-go (135 items)
- Holiday Inn Express & Suites Foley - N Gulf Shores by IHG -> holiday-inn-express-suites-foley-n-gulf-shores-by- (135 items)
- Americas Best Value Inn & Suites Foley Gulf Shores -> americas-best-value-inn-suites-foley-gulf-shores-Q8Jsdo (135 items)
- Econo Lodge Inn & Suites Foley-North Gulf Shores -> econo-lodge-inn-suites-foley-north-gulf-shores-HbltJQ (135 items)
- Pelican Grill -> pelican-grill (201 items)

Excluded per instructions: customers, bookings, waivers, Square/payment data.