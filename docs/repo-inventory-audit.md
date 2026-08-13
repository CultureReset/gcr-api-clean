# Repo inventory audit — 12 Aug 2026

> **Status update, 13 Aug 2026 — section 2 is now out of date, deliberately.**
> The ten-file bundle described below as unapplied has since been applied and
> pushed: `gcr-api-clean` commit `48a8bfe` (74 + 80 checks pass) and
> `Dashboards-users-` (build and discovery suite pass). Section 2 is kept as
> the record of what was found, not as current state. Everything in sections
> 3–6 that isn't the bundle — the key rotation, `PUBLIC_MCP_HIDE_PERSONAL`,
> the other three duplicate mounts, the admin App Store repoint, the remaining
> public pages, the menu-editor decision — is still open.

Re-check of the `untitled folder` bundle against the five repos as they stand
today. Every claim below was run against the cloned working trees, not read off
the prior documents. Where the prior documents were wrong, it says so.

**The single most important finding: none of the work in that bundle has been
applied to any repo.** It is a patch set that was produced, documented,
verified — and never landed. Every ship blocker the inspection listed is still
open in HEAD.

---

## 1. What you actually have — five repos, not four

The bundle's `repo-inventory.md` describes four. There is a fifth.

| Repo | Lines (js/jsx/mjs/css) | Role | In prior inventory? |
|---|---|---|---|
| `gcr-api-clean` | 59,367 | The API. 75 route files, 67 distinct mounts, 8 deliberately unmounted. Only thing holding a service key. | yes |
| `Admin-dashboard-main` | 30,043 | Operator console. 118 `.jsx` files, 87 registered section paths. Zero Supabase imports. | yes |
| `gcr-unified` | 37,957 | Public site. 77 pages. | yes |
| `Dashboards-users-` | 7,433 | Business dashboard. Self-building from live schema. | yes |
| `restaurant-menu-editor-MAIN-` | 5,590 | **Next.js 14 standalone menu editor. Not mentioned anywhere in the inventory.** | **no** |

Line counts differ from the prior document because this pass counted `.css`
alongside JS. The shape is the same; the omission of the fifth repo is not.

### The fifth repo, since nothing has described it

`restaurant-menu-editor-MAIN-` — Next.js 14 (pages router), React 18,
Playwright for tests. Deployed to Vercel (`vercel.json` present).

```
pages/index.js                 2,424 lines — the entire app in one component
pages/index-hardcoded-demo.js  1,274 lines — a frozen demo copy, still shipped
pages/new.js                     100 lines — business creation
pages/[slug].js                    9 lines
pages/api/upload.js               54 lines — proxies to /api/menu-editor/:slug/upload
pages/api/data.js                  3 lines — returns 410, deprecated
scripts/seed-menu.js, scripts/gulfislandgrill.json
tests/ (4 files) + 5 test scripts at the repo root
```

What's good: it holds **no Supabase key**. Everything goes through
`NEXT_PUBLIC_API_URL` → `gcr-api-clean`, PIN auth against
`/api/menu-editor/:slug`. It obeys the architecture rule.

What's a problem:

- It is a **fourth menu editor**. The API already mounts `menu-editor`,
  `menu-edit` and `simple-menu-edit`; the admin console has a menu-editors hub;
  the business dashboard has `MenuSection.jsx`. This repo is a fifth surface
  onto the same data.
- `index.js` is 2,424 lines in one file with menu data, gallery, share sheet,
  staff phones, and business settings all inline. Recent commits (camera
  capture, OS share sheet, staff phone management) are still being added to it,
  so it's actively growing, not frozen.
- `index-hardcoded-demo.js` still contains a full hardcoded Gulf Island Grill
  menu and points at `localhost:3001`. Dead weight that ships.
- README documents `PIN: 1234` as the demo PIN and hardcodes a build path from
  someone's laptop.
- Five one-off test scripts at the repo root (`full-test.js`, `full-test-v2.js`,
  `final-test.js`, `test-app.js`, `screenshot-test.js`) alongside `tests/`.

**Decision needed:** this is either the menu editor and the other three get
deleted, or it's a prototype and it gets archived. Right now it is a fourth
answer to a question already answered three times.

---

## 2. The bundle's work package — status: not applied

`README.md` in the bundle describes ten files across two repos. Verified
against HEAD today:

### gcr-api-clean (6 files)

| Change | State in repo |
|---|---|
| NEW `middleware/businessAccess.js` | **absent** — `middleware/` holds only `auth.js`, `ownerAuth.js` |
| NEW `routes/owner-availability.js` | **absent** |
| MOD `routes/email-parser.js` — guard 5 endpoints | **not applied** — `/manual` (1072), `/bulk-import` (1120), `/log` (1209), `/setup/:slug` (1278) all still open |
| MOD `routes/update-link.js` — guard `/generate`, persist passcode, fail closed | **not applied** — line 158 still unguarded, line 109 still `link.passcode \|\| '000000'` |
| MOD `routes/embed.js` — lead capture before handoff | **not applied** — line 321-323 still a bare `<a href={data.booking_url}>` |
| MOD `server.js` — dedupe mount, mount availability first, embed CORS + limiter | **not applied** — lines 374/375 are still the identical duplicate mount; no `/api/business/availability`; no `embedLeadLimiter` |

### Dashboards-users- (4 files)

| Change | State in repo |
|---|---|
| NEW `src/sections/AvailabilitySection.jsx` | **absent** — 15 files in `src/sections/`, not one of them |
| MOD `src/lib/endpoints.js` — availability block | **not applied** — zero matches for `availability` |
| MOD `src/pages/Dashboard.jsx` — pin the section first | **not applied** — zero matches |
| MOD `src/index.css` — `.muted`/`.small`/`.notice`/`.pill` tokens | **not applied** — none of those classes exist |

The two `.diff` files in the bundle apply cleanly in principle — the repos are
at the state those diffs were cut against. Nothing has drifted underneath them.

### Two bundle items that *are* clear

- `routes/intent.js` — **not present.** Either already deleted or never
  committed here. Nothing to do.
- `sql/booking_intents.sql` — **not present.** Twelve files in `sql/`, none of
  them that one. Nothing to do.

---

## 3. Ship blockers, re-verified today

Every one still open. Line numbers are current.

| # | Blocker | Proof |
|---|---|---|
| 1 | **service_role key in HEAD of public repos** | `gcr-api-clean/run_migration.js`, `gcr-unified/dump-entire-db.mjs`, `gcr-unified/export-supabase-complete.mjs`. Plus an anon key in `Dashboards-users-/docs/everything.html`. Rotate — deleting files does not remove git history. |
| 2 | **Anonymous business takeover** | `routes/update-link.js:158` `/generate` has no guard; `:109` `const expected = link.passcode \|\| '000000'`. Anyone can mint a 30-hour token and rewrite any business's menu, prices, photos, specials. |
| 3 | **Parser accepts anonymous writes** | `email-parser.js` `/manual`:1072, `/bulk-import`:1120, `/setup/:slug`:1278 (overwrites `daily_capacity` — denial-of-inventory), `/ical-import/sync-now/:id`. |
| 4 | **Parser leaks bookings** | `email-parser.js` `GET /log`:1209 — customer names, phones, raw email, filterable by `entity_slug`. |
| 5 | **Public MCP serves PII by default** | `lib/businessTables.js:225` — `PUBLIC_MCP_HIDE_PERSONAL` defaults off. One env var in production. |

Items 2–4 are exactly the patch set sitting unapplied in the bundle.

### Product blockers, also still open

| # | Gap | Proof |
|---|---|---|
| 6 | **Widget gives traffic away** | `routes/embed.js:321` hands to FareHarbor/Airbnb with no name, no phone, no click record. The front half of the loop, at its highest-value moment. |
| 7 | **Owner cannot touch their own availability** | No screen in `Dashboards-users-`. The only way to set capacity is the *unauthenticated* `/api/email-parser/setup/:slug`. |
| 8 | **Capture coverage on the public site: 2 of 7** | Seven pages emit a `booking_url`: `ArtistProfile`, `BusinessDetail`, `Itinerary`, `LinksPage`, `Search`, `ServiceListings`, `Swipe`. Three pages call `opt-in`/`track-click`: `Reserve`, `BusinessDetail`, `Swipe`. So **five** pages hand off with no capture. (The prior inspection said ten; on today's tree it is five — `Swipe.jsx` has since been wired, and several pages it listed no longer emit a booking URL at all.) |

---

## 4. Structural debt, measured

| Item | Measured today |
|---|---|
| `routes/dashboard.js` on the legacy convention | 5,640 lines, 277 `site_id` references. Largest file in the platform. |
| `routes/public.js` is legacy-only | 164 `site_id` references. Cannot see modern entity data. |
| Duplicate mounts in `server.js` | Four paths mounted twice: `/api/admin`, `/api/admin/gcr`, `/api/email-parser`, `/api/webhooks`. The prior doc found one. |
| Admin App Store points at a dead root | `Admin-dashboard-main/src/api/endpoints.js:453-455` calls `/api/apps`, unmounted at `server.js:301`. |
| One-off scripts at the API root | 38 `.js` files. |
| Schema versioning | 3 files in `migrations/` for a 563-table database. |
| `business-data.js` bypasses `buildFullEntity()` | Direct `.from('entity')` at lines 78 and 184. |
| Unmetered paid endpoints | `admin.js:2801 /gcr/ask`, `ocr.js:13 /receipt`, `verify-dns.js:9 /check`. |
| Dead dependency | `@supabase/supabase-js` still in `Dashboards-users-/package.json:18`, nothing imports it. |
| Dual auth | `gcr-unified/src/services/` carries both `supabaseAuth.js` and `firebaseAuth.js`. |

---

## 5. What to add, in order

**Today — apply what you already paid for.** The ten-file bundle closes
blockers 2, 3, 4, 6 and 7 in one pass. It was written against this exact tree
and was verified by execution, not eyeballing. Applying it is a copy, not a
build.

```
git apply gcr-api-clean.diff
git apply Dashboards-users-.diff
# then copy the three new whole files:
#   gcr-api-clean/middleware/businessAccess.js
#   gcr-api-clean/routes/owner-availability.js
#   Dashboards-users-/src/sections/AvailabilitySection.jsx
```

**Today, separately — the two things no patch can do for you.**

1. Rotate the `service_role` key in Supabase `mkepugvdlktfsossumox`, move the
   three scripts to `process.env`, then scrub history or privatise the repos.
2. Set `PUBLIC_MCP_HIDE_PERSONAL=true` in the production environment.

**This week.**

3. Delete the other three duplicate mounts in `server.js` (the bundle only
   removes the `email-parser` one).
4. Repoint `Admin-dashboard-main/src/api/endpoints.js:453-455` from `/api/apps`
   to the composio owner router at `/api/connections`.
5. Add capture to the five public pages still handing off blind:
   `ArtistProfile`, `Itinerary`, `LinksPage`, `Search`, `ServiceListings`.
   The pattern exists in `Reserve.jsx` — copy it.
6. Decide the menu editor question. One of the four survives.
7. Rate-limit `/gcr/ask`, `/ocr/receipt`, `/verify-dns/check`.

**The real remaining build — matching.** The parser writes
`email_parser_events`; the design has `matched_entity_slug` and
`matched_booking_id`; nothing computes them. With capture applied you will have
intent rows and confirmation rows in the same database and no job joining them.
That job is the product. It is one worker, not a rewrite — but it is genuinely
missing and no bundle in that folder contains it.

**Then the schema fork.** 244 designed tables vs 563 live, 19 concepts under
two names, 6 of which exist as two real tables at once. Writes land in either
and reads disagree. Nothing downstream is trustworthy until this is settled.

---

## 6. Where the prior documents were wrong

Worth recording so the next pass doesn't inherit the errors.

- **"Four live repos."** Five. `restaurant-menu-editor-MAIN-` was never
  inventoried.
- **"Duplicate mount — delete line 375."** There are four duplicated mount
  paths, not one.
- **"Ten public pages leak intent."** Five do today. `Swipe.jsx` was wired in
  the meantime, and several listed pages no longer emit a `booking_url`.
- **"Intent capture does not exist"** (`repo-inventory.md` §5) contradicts
  **"Intent capture also exists and works"** (`full-inspection.md` §4.1). The
  inspection is right: `POST /api/gcr/opt-in` at `gcr.js:2664` and
  `POST /api/tourist/track-click` at `tourist.js:1735` both exist and the
  parser reads `booking_opt_ins.sms_consent` back. The endpoints are built;
  what's missing is the *surfaces calling them* and the *matcher joining them*.
- **`routes/intent.js` and `sql/booking_intents.sql`** are listed for deletion
  in two documents. Neither exists in this tree.

---

## 7. The one-line version

You have five repos, not four, and one of them is an unaccounted-for fourth
menu editor. The infrastructure is as good as the prior documents say. The
ten-file work package that fixes the takeover chain, the anonymous parser
writes, the PII leak, the widget capture gap and the missing owner availability
screen is **written, verified, and sitting in a zip on your desktop instead of
in your repos.** Apply it, rotate the key, then build the matcher — that last
one is the only thing on this page that still needs inventing.
