# The bundle, file by file

> **Status update, 13 Aug 2026 — the bundle has been applied.**
> Section 0 below proves it *was* unapplied when this was written; that is now
> history. All ten files are in, on `claude/repo-inventory-audit-5zw4yw` in
> both repos. The per-file descriptions in sections 3 and 4 remain accurate as
> documentation of what each file does. **Section 6 — what the bundle does not
> contain — is unaffected and still the live to-do list**, starting with the
> service_role key rotation and `PUBLIC_MCP_HIDE_PERSONAL=true`.

Every file in `untitled folder`, what it is, which repo it belongs to, which
exact path it lands at, whether it's backend or UI, and what it does.

Companion to `repo-inventory-audit.md`, which covers the repos themselves.

---

## 0. Proof that none of it is applied

Not inference — three independent checks, all run today.

**Check 1 — the diffs apply clean.** A patch only applies cleanly against the
exact file state it was cut from. If any of it had landed, these would reject:

```
gcr-api-clean:      git apply --check gcr-api-clean.diff      → 4/4 files OK, 0 rejects
Dashboards-users-:  git apply --check Dashboards-users-.diff  → 3/3 files OK, 0 rejects
```

**Check 2 — the three new files are absent.** `middleware/businessAccess.js`,
`routes/owner-availability.js`, `src/sections/AvailabilitySection.jsx`: none
exist in any repo.

**Check 3 — the whole-file copies and the diffs agree.** Applied both diffs to
a scratch clone, then compared the result against the bundle's whole-file
copies. All seven byte-identical. The bundle is internally consistent, so you
can use either method — `git apply`, or straight file copy — and land in the
same place.

**Conclusion: you are missing all ten files. Nothing is partially applied.**

---

## 1. What's actually in the zip — 27 files, 4 kinds

| Kind | Count | Notes |
|---|---|---|
| Code to install | 10 | The work package. All of it missing from your repos. |
| Accidental duplicates | 3 | `businessAccess 2.js`, `email-parser 2.js`, `update-link 2.js` — **byte-identical** to their non-`2` twins. macOS copy artifacts. Ignore them; do not install both. |
| Patch files | 2 | `gcr-api-clean.diff`, `Dashboards-users-.diff` — an alternative to copying the 7 modified files. |
| Documents | 12 | Markdown. No code. Reference material, not deliverables. |

Verified identical:
```
businessAccess.js == businessAccess 2.js
email-parser.js   == email-parser 2.js
update-link.js    == update-link 2.js
```

---

## 2. Which repos are touched — the short answer

| Repo | Files in this bundle |
|---|---|
| `gcr-api-clean` | **6** — all backend |
| `Dashboards-users-` (the **business owner's** dashboard) | **4** — 3 UI, 1 config |
| `Admin-dashboard-main` (your operator console) | **0** |
| `gcr-unified` (public site) | **0** |
| `restaurant-menu-editor-MAIN-` | **0** |

So: **it's mostly backend, and the only front end it touches is the business
owner's dashboard — not your admin console.**

One thing to watch: the bundle contains a file called `endpoints.js`, and
*both* dashboards have a file by that name. This one is the **user** dashboard's
(`Dashboards-users-/src/lib/endpoints.js`, 102 lines), not the admin console's
(`Admin-dashboard-main/src/api/endpoints.js`, 741 lines). Confirmed by content
match. Copying it to the wrong repo would wipe your admin route map.

---

## 3. gcr-api-clean — 6 files, all backend

### 3.1 `middleware/businessAccess.js` — NEW · 118 lines · backend, no UI

**Lands at:** `gcr-api-clean/middleware/businessAccess.js`
**Currently:** `middleware/` holds only `auth.js` and `ownerAuth.js`.

A third auth guard, because neither existing one fits the endpoints below.
`adminRequired` locks business owners out; `ownerRequired` locks the admin
console out; these routes serve both.

It accepts either credential and normalises the answer onto the request:

| Credential | How it's checked | Result |
|---|---|---|
| Admin Express JWT (`Bearer`) | `jwt.verify` against `JWT_SECRET`, `role === 'admin'` | `req.isAdmin = true`, `req.scopeSlug = null` (may act on any business) |
| Business owner Supabase token | `supabase.auth.getUser()` → `entity_owners` lookup | `req.scopeSlug = <the one slug they own>` |
| Supabase token, no `entity_owners` row | falls back to a `platform_admins` check | treated as admin |
| Anything else | — | 401/403 |

Exports three things. Routes only ever call one:

```js
const slug = assertSlug(req, res, req.body.entity_slug);
if (!slug) return;                    // already responded 403
```

`assertSlug` compares what the caller *asked for* against what the server
*resolved*. Mismatch is 403 no matter what the body said. This is the existing
"the slug is never taken from the request" rule, extended to a caller type that
didn't have a guard for it.

### 3.2 `routes/owner-availability.js` — NEW · 324 lines · backend, no UI

**Lands at:** `gcr-api-clean/routes/owner-availability.js`
**Mounted at:** `/api/business/availability` (the `server.js` change does this)
**Currently:** does not exist. There is no authenticated way for an owner to
touch their own capacity at all.

Five endpoints, every one wrapped in `ownerRequired`. **No handler reads a slug
from the request** — it comes from the session.

| Verb | Path | What it does |
|---|---|---|
| `GET` | `/` | Returns capacity, raw day rows, blocks, **and the merged public view** for a date range |
| `PUT` | `/capacity` | Set or clear `daily_capacity` — the number every count subtracts from |
| `PUT` | `/day` | Correct what's actually booked on one date (when the parser got it wrong) |
| `POST` | `/block` | Close a date entirely — entity-wide, vetoes every other source |
| `DELETE` | `/block/:id` | Reopen. Marks the block cancelled rather than deleting the row |

Two design points worth knowing:

- `remaining_spots` and `status` are computed **server-side** (`statusFor()`),
  so the arithmetic can't be right in the API and wrong in the UI.
- The public-view column comes from `require('./availability-engine')` — the
  *same* merge function the embeddable widget and public search use. An owner
  sees exactly what a tourist sees, and the two cannot drift.

### 3.3 `routes/email-parser.js` — MODIFIED · backend

**Lands at:** `gcr-api-clean/routes/email-parser.js`

Adds a `manualEntryAllowed` guard function at the top of the file (58 new lines
after line 25), then guards five endpoints.

| Endpoint | Current line | Before | After |
|---|---|---|---|
| `POST /inbound` | 953 | public | **unchanged, still public** — SendGrid has no credential to present |
| `POST /manual` | 1072 | anyone | `manualEntryAllowed` |
| `POST /bulk-import` | 1120 | anyone | `businessAccess` + `assertSlug` |
| `GET /log` | 1209 | anyone | `businessAccess`, forced to caller's slug |
| `POST /setup/:slug` | 1278 | anyone | `businessAccess` + `assertSlug` |
| `POST /ical-import/sync-now/:id` | 1456 | anyone | `businessAccess`, checked against **the feed row's own slug**, not the URL id |

**`/manual` is the interesting one.** It has two legitimate callers — the public
Reserve page (an anonymous tourist) and the admin console (staff entering a
phone booking). So it can't just require a session. The solution: an anonymous
caller must present an `opt_in_id` that was issued against that same slug, which
means **a name and phone were captured before the booking was written**. The
opt-in row is the capability.

Public callers are additionally:
- pinned to `status: 'pending'` — only an authenticated caller can assert a
  booking is confirmed
- capped at party size 50

And the handler now writes `entity_slug: slug` (server-resolved) instead of
`entity_slug` (whatever was in the body) on the insert, the `upsertAvailability`
call, and the confirmation send.

**What this closes:** today anyone can POST to `/setup/:slug` and set a
competitor's `daily_capacity` to 1, which makes them show "Booked" to every
tourist on GCR. And anyone can `GET /log?entity_slug=x` and read that business's
customer names, phone numbers and raw email text.

### 3.4 `routes/update-link.js` — MODIFIED · backend

**Lands at:** `gcr-api-clean/routes/update-link.js`

Three changes that together close a full anonymous-takeover chain.

| Line | Change |
|---|---|
| 158 | `router.post('/generate', ...)` → `router.post('/generate', adminRequired, ...)` |
| ~176 | The `passcode` field was destructured from the body at line 159 and **never written to the insert** — so every link ever minted stored `NULL`. It's now persisted, defaulting to a random 6-digit code, and returned in the response |
| 109 | `const expected = link.passcode \|\| '000000'` → refuses outright when `passcode` is null, with `expired_scheme: true` |

**The chain as it stands today:** anyone POSTs an `entity_id` to `/generate` (no
auth) → gets a token valid 30 hours → passcode is NULL → `validateToken` reads
NULL as `'000000'` → send header `x-link-passcode: 000000` → full write access to
that business's photos, specials, menu sections, menu items and drink items.

The tell that this was an oversight rather than a design: its siblings
`/send-sms` (190) and `/links/:token/passcode` (181) were **always**
`adminRequired`. `/generate` was just missed.

**Tradeoff to plan for:** links minted before this fix will 401. They expire
within 30 hours anyway, so it self-heals by tomorrow — but if a business is
mid-edit when you deploy, regenerate for them.

### 3.5 `routes/embed.js` — MODIFIED · backend **and** the widget UI

**Lands at:** `gcr-api-clean/routes/embed.js`

This file is unusual: it's a backend route that also *serves* a self-contained
JavaScript widget as a string (`widgetSource()`), so the UI change lives in the
backend file. There is no separate front-end file to copy.

**NEW endpoint — `POST /api/embed/lead/:slug`** (82 lines):
- validates the slug is a real, `is_active` business first (otherwise it's a
  free write endpoint for anyone who wants to fill a table with junk)
- inserts `tourist_click_events` with `click_type: 'widget_booking'`
- inserts `booking_opt_ins` with name / phone / email / `sms_consent` /
  `consent_text`, linked by `click_id`
- returns `opt_in_id`, `click_id`, `booking_url`, `phone`

Click attribution is wrapped in its own try/catch — losing attribution is
better than losing the lead.

**The widget itself:** today, at line 321–329, it renders

```js
var a = el('a', null, 'Book now');
a.href = data.booking_url;        // ← straight out to FareHarbor / Peek / Airbnb
```

After: that becomes a `<button>` that opens a small inline form — name, mobile,
one consent checkbox — posts to `/lead/:slug`, then hands off.

Two implementation details that matter and are easy to break if you rewrite it:

1. **The destination window is opened synchronously inside the click handler**
   and pointed at its URL after the request returns. Open it afterwards and
   every popup blocker on earth eats it.
2. If the lead write fails, the customer still gets where they were going. The
   capture never blocks the booking.

Also adds `CONSENT_TEXT` as a constant, stored verbatim on the opt-in row —
for a consent record, *what* was agreed to matters as much as that something
was. Plus ~12 CSS rules for the capture step, all inheriting the host page's
font and colour so it reads as part of the business's own site.

**This is the highest-value change in the bundle.** It's the front half of your
loop, and it's the one the whole thesis depends on.

### 3.6 `server.js` — MODIFIED · backend wiring

**Lands at:** `gcr-api-clean/server.js`

Four changes:

| # | Change | Why it's not optional |
|---|---|---|
| 1 | Delete the duplicate `mount('/api/email-parser', ...)` at line 375 | Express registers the router twice; any router-level middleware or side effect fires twice |
| 2 | `mount('/api/business/availability', ...)` inserted **before** `/api/business` (line ~212, ahead of the mount at 192) | `business-data.js` ends in a `/:table` catch-all that would otherwise swallow `/availability` and try to read a table by that name. Order is load-bearing |
| 3 | `app.use('/api/embed', cors({ origin: '*', credentials: false }))` | **Not cosmetic.** Your CORS allowlist is 8 fixed domains. The widget's entire purpose is to sit on `reeldealcharters.com`, which will never be on that list — so the browser was blocking it on every real customer site. It couldn't fetch its own availability, let alone post a lead. Safe to open because these routes return day counts and colours, never a booking row |
| 4 | `embedLeadLimiter` — 20/min per IP, override via `EMBED_LEAD_RATE_LIMIT` | The lead route is the one embed path that accepts personal data |

**Note:** this change only removes *one* of your duplicate mounts. There are
four duplicated paths in `server.js` — `/api/admin`, `/api/admin/gcr`,
`/api/email-parser`, `/api/webhooks`. The other three are yours to clean up
separately.

---

## 4. Dashboards-users- — 4 files (the business owner's dashboard)

To be clear about which dashboard: this is the one **your customers** log into
to manage their own business. Not your admin console.

### 4.1 `src/sections/AvailabilitySection.jsx` — NEW · 335 lines · **UI**

**Lands at:** `Dashboards-users-/src/sections/AvailabilitySection.jsx`
**Currently:** `src/sections/` holds 15 files. This is not one of them.

The screen that does not exist. Today a business owner can see their menu,
hours, photos, offerings, and watch bookings arrive read-only — but they
**cannot set their capacity, block a date, or correct a wrong count.** The only
way to set capacity right now is the *unauthenticated* `POST /api/email-parser/setup/:slug`.

What it renders, in the order an owner cares about:

1. **What customers currently see** first — the merged public view. That's the
   thing an owner actually worries about
2. Capacity behind it, in one field
3. Per-day correction, inline
4. Close/reopen a date as a distinct action from "full"

Standard React — `useState`/`useEffect`/`useCallback`, a 14-day default range,
calls `api.get/put/post/del` against the `endpoints.availability.*` map below.
It owns its own reads and writes rather than going through the generic CRUD
wrapper.

### 4.2 `src/lib/endpoints.js` — MODIFIED · config

**Lands at:** `Dashboards-users-/src/lib/endpoints.js` — **not** the admin
dashboard's `src/api/endpoints.js`.

Adds a 16-line `availability` block to the exported endpoint map:

```js
availability: {
  range:    (from, to) => `${BUSINESS}/availability?from=…&to=…`,
  capacity: ()   => `${BUSINESS}/availability/capacity`,
  day:      ()   => `${BUSINESS}/availability/day`,
  block:    ()   => `${BUSINESS}/availability/block`,
  unblock:  (id) => `${BUSINESS}/availability/block/${seg(id)}`,
}
```

Note no path carries a slug — same rule as the rest of the file.

### 4.3 `src/pages/Dashboard.jsx` — MODIFIED · **UI**

**Lands at:** `Dashboards-users-/src/pages/Dashboard.jsx`

Three small edits:

1. Import `AvailabilitySection`
2. Rename `sections` → `discovered`, then **pin** an `__availability` entry at
   the front of the list
3. Render `<AvailabilitySection />` directly when it's active — deliberately
   *outside* `EditableSection`, because it owns its own reads and writes

**Why pinned rather than discovered:** your discovery engine only surfaces a
section once the table has rows. A business with no capacity set has no rows —
which is exactly the business that needs this screen most. Left to discovery it
would be invisible to every business that hasn't been onboarded yet.

### 4.4 `src/index.css` — MODIFIED · **UI styling**

**Lands at:** `Dashboards-users-/src/index.css` (appends 73 lines after line 828)

Styles for the availability screen, plus the shared `.muted`, `.small`,
`.notice`, `.error`, `.link`, `.pill` classes it uses — **none of which
currently exist in your CSS** (verified: zero matches). Every value is a token,
per the file's own rule that nothing below the token block contains a colour
literal, so dark mode follows with no second rule.

---

## 5. The 12 documents — reference, not deliverables

None of these are code. None of them go into a repo as-is. Three describe your
current system; nine describe a future one.

### About the code that exists

| File | Lines | What it is |
|---|---|---|
| `README.md` | 213 | **Read this first.** The install guide for the 10 files above — what each does and the verification that was run |
| `full-inspection.md` | 313 | The security + structure audit with file:line proof. The source of the ship-blocker list. Largely still accurate; see `repo-inventory-audit.md` for the three counts that have changed |
| `repo-inventory.md` | 234 | The four-repo inventory. Superseded — it misses the fifth repo and contradicts `full-inspection.md` on whether intent capture exists |
| `launch-plan.md` | 176 | Answers a specific question: "owner pastes their tool URLs → data gets extracted → app gets added." Verdict: extraction is built (`routes/ingest.js`, `gcr/deep-crawl.js`), the App Store is built (`routes/composio.js`), but **there is no table for a business's tool URLs** and no screen to enter them |

### About the concept

| File | Lines | What it is |
|---|---|---|
| `concept-architecture.md` | 158 | The five-part loop — sources → structure → surfaces → intent → proof — described independent of any implementation. The clearest statement of what you're building |
| `positioning.md` | 114 | Synthesized from 19 landing pages. Argues you're currently telling three incompatible stories under overlapping names, and picks one. Brand consolidation, message hierarchy, pricing, ship order |

### About "Ghost" — the physical box, a different product

These describe a per-business hardware device that operates that business's own
apps under its own credentials. **None of it is in any of your five repos.** Read
them as design work, not as a backlog.

| File | Lines | What it is |
|---|---|---|
| `ghost-system-spec-v2.md` | 672 | The current spec. Explicitly **supersedes** `ghost-build-spec.md`. Every line marked with provenance — `[M]` you decided, `[A]` agreed, `[R]` unsigned research, `[OPEN]` undecided — because prior sessions let research hide in specs as though it were settled |
| `ghost-build-spec.md` | 663 | v1. Marked "donor document only" by v2. Its A2P 10DLC content is stated to be **wrong and deleted, not carried** — don't work from this file |
| `ghost-foundation-spec.md` | 351 | The concrete contracts: screen state, screen signature, app map, workflow. Everything versioned by `(package, app_version, device_profile)` |
| `ghost-positioning-and-ip.md` | 300 | The language document — the rent-vs-own argument, federated channels, what is and isn't patentable, and an agenda for the patent attorney |
| `ghost-near-term-path.md` | 159 | Gates and sequencing. **Gate 1 is the key rotation**, marked still pending |
| `session-recap-nano-hardware-storage.md` | 149 | Gemini Nano, hardware sizing (phone vs Pi), storage, generated-media flow |

**Suggested home:** a `docs/` folder in whichever repo you treat as canonical,
or a separate `gcr-docs` repo. They shouldn't live in a zip on a desktop, which
is how the ten code files ended up unapplied.

---

## 6. What the bundle does NOT contain

Do not read "apply the bundle" as "done." These are still yours:

| # | Item | Why no patch can do it |
|---|---|---|
| 1 | **Rotate the `service_role` key** | Console + env work. Live in HEAD of `run_migration.js`, `dump-entire-db.mjs`, `export-supabase-complete.mjs`. Deleting files doesn't help — git history keeps them |
| 2 | **`PUBLIC_MCP_HIDE_PERSONAL=true`** | Production env var. Without it `/api/mcp/business/:slug` serves customer names and phones to anyone who types the URL |
| 3 | **The matcher** | `email_parser_events` has `matched_entity_slug` and `matched_booking_id` in the design; **nothing computes them.** After capture lands you'll have intent rows and confirmation rows in one database and no job joining them. This is the actual product and it is not written |
| 4 | **Admin App Store repoint** | Deliberately left alone. `/api/apps` and the composio router have genuinely different shapes (`/apps/install` vs `/:slug/:toolId/connect`). `AppManager.jsx` already carries a warning about two competing catalogues. Needs your call on which wins |
| 5 | **Capture on the remaining public pages** | `ArtistProfile`, `Itinerary`, `LinksPage`, `Search`, `ServiceListings` still hand off blind. After this bundle the pattern exists in three places — copy-paste, not engineering |
| 6 | **The other three duplicate mounts** | `/api/admin`, `/api/admin/gcr`, `/api/webhooks` |
| 7 | **The `upsertAvailability` subtraction bug** | Lookup uses `.eq('time_slot', event_time \|\| '00:00')`, insert writes `time_slot: event_time \|\| null` — so NULL rows are never found again |
| 8 | **The menu editor decision** | Four editors, one job |

---

## 7. Install order

The two halves are independent — the API changes don't need the dashboard, and
the dashboard screen 404s harmlessly until the API side is up. But deploy the
API first so the screen has something to talk to.

```
# 1. gcr-api-clean
cp  businessAccess.js       gcr-api-clean/middleware/businessAccess.js
cp  owner-availability.js   gcr-api-clean/routes/owner-availability.js
cd  gcr-api-clean && git apply /path/to/gcr-api-clean.diff
npm run verify && npm run test:mcp

# 2. Dashboards-users-
cp  AvailabilitySection.jsx  Dashboards-users-/src/sections/AvailabilitySection.jsx
cd  Dashboards-users- && git apply /path/to/Dashboards-users-.diff
npm run build && npm run check && npx oxlint
```

Ignore the three ` 2.js` files entirely. Do not copy `endpoints.js` into
`Admin-dashboard-main`.
