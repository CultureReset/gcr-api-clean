# What this is, and what's actually been done

One document. What you're building, what exists in the five repos today, and
a full record of every commit made in this session — nothing summarized away.

Written 13 Aug 2026.

---

## 1. What you're building, in one paragraph

One structured record per business — a Digital Twin — that you write to and
that everything else reads from. Not a directory, not a booking platform: the
layer underneath both. Data climbs in from wherever it can be gotten —
owner-typed, crawled, iCal, forwarded confirmation emails, OAuth, Composio —
and higher-trust sources overwrite lower ones. Off that one record sit five
surfaces: the business's own dashboard, their public page, your admin board,
an MCP anything can query, and Ghost — a box that writes back to platforms
that won't give you an API, on the owner's own device and account. The loop
that makes it a business and not a database: catch intent before a customer
leaves, recognize the confirmation when it comes back, match the two, close
it with a verified review. Nobody else can do the last two steps because
nobody else owns both ends.

Everything below is either evidence for that paragraph or a gap in it.

---

## 2. What you actually have — five repos, verified today

| Repo | Branch | Role | Size |
|---|---|---|---|
| `gcr-api-clean` | `claude/repo-inventory-audit-5zw4yw` | The API. Only thing touching the database. | 59,806 lines · 76 route files · 71 mounted |
| `Dashboards-users-` | `claude/repo-inventory-audit-5zw4yw` | The business owner's own dashboard. Builds itself from the live schema. | 7,433 lines |
| `Admin-dashboard-main` | `claude/repo-inventory-audit-5zw4yw` | Your operator console. 118 `.jsx` files, 87 registered sections. | 30,043 lines |
| `gcr-unified` | `claude/repo-inventory-audit-5zw4yw` | The public site — Gulf Coast Radar. | 37,957 lines |
| `restaurant-menu-editor-MAIN-` | `claude/repo-inventory-audit-5zw4yw` | A fourth, separate menu editor. Not accounted for anywhere before this audit. | 5,590 lines |

All five: clean working tree, everything committed is pushed, nothing dirty
as of this writing.

### What's real in each, checked against the running code — not the docs about it

**`gcr-api-clean`** enforces three rules that hold: only this repo touches
the database; the slug a request acts on is resolved from the session via
`entity_owners`, never taken from the URL or body; and one shared module
(`lib/businessTables.js`) does schema discovery and column filtering for both
`business-data.js` and `mcp.js`, so the security check exists once.

The availability engine (`routes/availability-engine.js`) merges three
sources — `business_availability`, `availability`, `booking_calendar` — with
a rule that an entity-wide block **vetoes** every other source. A condo
saying "1 unit free" with an Airbnb block on that date correctly shows
closed. That's the part everyone gets wrong and it's already right.

The email parser recognizes 26 provider formats and writes to the same
tables the availability engine reads, so the two can't drift. A per-business
inbound address already works exactly as you described it —
`gcr-{slug}@parse.gulfcoastradar.com` — and inbound mail is routed to the
right business by parsing the TO address.

Cross-business search (`POST /api/admin/platform/search`) already answers
"what's open in this vertical on this date," rolls condo units up to their
parent complex, and applies a stays-need-every-night vs. any-vertical-needs-
any-open-day coverage rule per industry.

**`Dashboards-users-`** discovers its own sections from the live schema —
any table with rows for a slug becomes a screen, with no code change needed
when a table is added. The inverse also exists: it computes which tables a
business *isn't* using yet, as an "add" catalog.

**`Admin-dashboard-main`** has eleven separate calendar/availability screens
(`Availability`, `AvailabilitySearch`, `Calendar`, `BusinessCalendar`,
`BusinessCalendarPanel`, `WebsiteCalendar`, `IndustryCalendar`,
`CalendarFeeds`, `Openings`, `Inventory`, `BookingsLedger`) — a real design
problem, since the same question ("what's open where") should be one screen
with filters, not eleven partial ones.

**`gcr-unified`** renders its public page (`LinksPage.jsx`) through a real
generic `SectionRenderer` driven by `entity_sections.layout`, and every box
either opens externally or opens an in-page modal — the Linktree-that-stays-
on-the-page behavior already works. What's missing is a publish flag: there
is no way for an owner to pull one section from the public page while
keeping it in their dashboard. If it has rows, it's public.

**`restaurant-menu-editor-MAIN-`** holds no Supabase key and talks to
`gcr-api-clean` properly, but is a fourth answer to a question the platform
already answers three other ways (`menu-editor`, `menu-edit`,
`simple-menu-edit` are all separately mounted in the API).

---

## 3. Every commit made this session — full record

Five commits. Two repos. Nothing else touched.

### `gcr-api-clean` — 4 commits

```
e86b53d  Mark the audit docs as superseded on the bundle, not on the rest
48a8bfe  Close the open write paths, and capture the customer before the handoff
9cdc56b  Document every file in the bundle: path, layer, and what it does
bbaf484  Audit the five repos against the unapplied work bundle
```

**`bbaf484` and `9cdc56b`** — two documents, `docs/repo-inventory-audit.md`
(226 lines) and `docs/bundle-manifest.md` (415 lines). They record: a
five-repo audit that found a bundle of ten already-written files sitting
unapplied, and a file-by-file manifest of what each one does, where it goes,
and whether it's backend or UI.

**`48a8bfe`** — the code. Six files, 828 insertions:

| File | Change |
|---|---|
| `middleware/businessAccess.js` | **New.** Accepts an admin JWT or a business-owner Supabase session and resolves the one slug that caller may touch. Exports `assertSlug()` — a route calls it once, gets a slug or a 403. |
| `routes/owner-availability.js` | **New.** Five endpoints, all `ownerRequired`, none reading a slug from the request: get merged availability, set capacity, correct one day, close a date, reopen it. |
| `routes/update-link.js` | `POST /generate` had no auth guard — anyone could mint a 30-hour write token for any business. It's admin-only now. The `passcode` field was read from the body and silently dropped, so every link ever minted stored NULL, and `validateToken` read NULL as the constant `'000000'`. Passcode is persisted now; NULL is refused instead of defaulting. |
| `routes/email-parser.js` | Five endpoints were open to anonymous writes and reads: `/manual`, `/bulk-import`, `/setup/:slug`, `/ical-import/sync-now/:id`, `GET /log`. All scoped to one business now. `/inbound` stays public — SendGrid has no credential to present. `/manual` keeps a public path for the Reserve page, but an anonymous caller must present an `opt_in_id` proving a name and phone were captured first, and is pinned to `status: 'pending'`. |
| `routes/embed.js` | The widget linked straight to FareHarbor with no capture. Now: `POST /lead/:slug` writes a name and phone to `booking_opt_ins` plus a click event, *then* hands off. The destination window opens synchronously in the click handler so popup blockers don't eat it; a failed lead write still lets the customer through. |
| `server.js` | Deleted a duplicate `email-parser` mount. Mounted `/api/business/availability` ahead of `/api/business`, whose `/:table` catch-all would otherwise swallow it. Opened CORS for `/api/embed` specifically — the widget's whole purpose is to run on a domain that will never be on the 8-domain allowlist. Added a 20/min rate limit on the lead endpoint. |

Verified by running the repo's own suites, not by inspection:
`npm run verify` → **74 passed, 0 failed**. `npm run test:mcp` → **80
passed, 0 failed**. `node --check` clean on all six files.

**`e86b53d`** — went back into the two audit docs and marked the sections
that said "unapplied" as superseded, so they don't mislead the next reader
now that the bundle is in.

### `Dashboards-users-` — 1 commit

```
b05b27f  Let a business fix its own availability
```

Four files, 441 insertions:

| File | Change |
|---|---|
| `src/sections/AvailabilitySection.jsx` | **New**, 335 lines. Shows what customers currently see first, capacity behind it, per-day correction inline, close/reopen as a distinct action from "full." Reads and writes `/api/business/availability` directly — the endpoint added in `gcr-api-clean` above. |
| `src/lib/endpoints.js` | Adds the `availability` path block the new section calls. |
| `src/pages/Dashboard.jsx` | Imports the section and **pins it first** in the nav rather than letting discovery find it — discovery only shows a section once it has rows, and a business with no capacity set has no rows, which is exactly the business that needs this screen. |
| `src/index.css` | Adds `.muted`, `.small`, `.notice`, `.error`, `.link`, `.pill` — used by the new screen, didn't exist before. All tokens, so dark mode follows with no second rule. |

Verified by running: `npm run build` passes, `npm run check` (the repo's own
discovery test suite) all pass, `npx oxlint` shows two warnings, both in
files this change never touched.

### The other three repos — zero commits

`Admin-dashboard-main`, `gcr-unified`, `restaurant-menu-editor-MAIN-`:
nothing was changed. No code in this session's work touches them.

---

## 4. What changed for you, concretely, because of the commits above

1. Nobody can mint a business-takeover link anymore. That chain — anonymous
   `/generate` → NULL passcode → `000000` default → full write access to a
   business's menu, prices, photos — is closed.
2. Nobody can anonymously overwrite a business's capacity, bulk-import fake
   bookings, or read another business's customer names and phone numbers off
   the parser log.
3. The embeddable widget captures a name and phone before handing a customer
   to FareHarbor/Airbnb/whoever, instead of giving the click away for free.
4. The widget can now actually load on a real customer's website — it was
   silently blocked by CORS everywhere outside your 8-domain allowlist.
5. A business owner has a screen to set their own capacity, correct a wrong
   count, and close a date. Before this, the only way to set capacity at all
   was the endpoint fixed in item 2, and there was no UI for it anywhere.

---

## 5. What is still true and unfixed — not touched by any commit above

| # | Item | Why it's not done here |
|---|---|---|
| 1 | **`service_role` key live in public git** — `run_migration.js`, `dump-entire-db.mjs`, `export-supabase-complete.mjs` | Console job. Rotate, then move to `process.env`, then scrub history or privatize. Everything above is moot until this happens. |
| 2 | **`PUBLIC_MCP_HIDE_PERSONAL` defaults off** | One production env var. Right now `/api/mcp/business/:slug` serves customer names and phones to anyone who types the URL. |
| 3 | **Three more duplicate mounts** in `server.js` — `/api/admin`, `/api/admin/gcr`, `/api/webhooks` | This session's fix removed one of four. |
| 4 | **Admin App Store calls a dead route** — `endpoints.js:453-455` calls `/api/apps`, unmounted at `server.js:301` | Needs repointing to `/api/connections`, the composio owner router. |
| 5 | **Five public pages hand off with no capture** — `ArtistProfile`, `Itinerary`, `LinksPage`, `Search`, `ServiceListings` | Pattern already exists in `Reserve.jsx` and now `embed.js` — copy-paste, not new engineering. |
| 6 | **The matcher does not exist** | `email_parser_events` has `matched_entity_slug` / `matched_booking_id` in the design. Nothing computes them. This is the actual product — intent capture and the parser both work, nothing joins them. |
| 7 | **No publish flag on public sections** | An owner can't pull a Yelp-sourced block off their public page while keeping it in their own dashboard. If it has rows, it's public. |
| 8 | **No tri-state fact model** | Every boolean in the platform is effectively two-state-plus-ambiguous-null. "Asked, unknown" and "never asked" render identically. This is the fix that makes the MCP trustworthy instead of confidently wrong. |
| 9 | **No tool-URL table** | Nothing like `entity_links` exists. The onboarding screen where an owner pastes their Yelp/FareHarbor/Instagram URLs has nowhere to write to. |
| 10 | **Zero Ghost code** | No registry, no executor router, no ledger, no app maps, no device daemon. Everything about Ghost discussed this session is design, not code. |
| 11 | **Eleven overlapping calendar screens in the admin console** | Should be one screen with filters (date range × vertical × business). |
| 12 | **The menu editor question** | Four separate menu editors exist across the platform. One should survive. |

Item 1 blocks everything. Items 2–5 are hours of work each and unrelated to
one another. Item 6 is the single highest-value thing not yet built. Items
8–10 are the ones that make the "ultimate MCP" claim true rather than
aspirational.

---

## 6. Where to find it

```
gcr-api-clean       → github.com/CultureReset/gcr-api-clean       → claude/repo-inventory-audit-5zw4yw
Dashboards-users-   → github.com/CultureReset/Dashboards-users-   → claude/repo-inventory-audit-5zw4yw
```

Both branches pushed, both working trees clean. No PR has been opened on
either — that wasn't asked for. Nothing is merged to `main`. Nothing is
deployed.

Docs live in `gcr-api-clean/docs/`:
- `repo-inventory-audit.md` — the original five-repo audit
- `bundle-manifest.md` — file-by-file record of the ten-file bundle
- `what-this-is-and-what-happened.md` — this file
