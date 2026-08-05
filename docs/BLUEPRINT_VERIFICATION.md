# gcr-api-clean blueprint — verification pass

Checked the 43-page *Complete Wiring Blueprint* (§0–11 + Appendices A–S) against
the code on disk at HEAD `b75300c`, the same commit the blueprint claims to have
been computed from.

**Verdict: the blueprint is accurate on the code spine.** Every route file, lib,
util, middleware and extractor is named somewhere in it; the mount map matches
`server.js` exactly, including the duplicate mounts and all eight commented-out
routers with their reasons; the line counts are right file by file; and the two
carryover bugs it flags are still on disk.

Below is what the check turned up: two errors, one omission, and one whole layer
of the repo that has no coverage at all.

---

## 1. Confirmed accurate

| Claim | Verified |
|---|---|
| HEAD `b75300c` | ✓ |
| Per-file line counts (all 8 giants, both engines, every lib/util) | ✓ — `dashboard.js` 5,640 · `admin.js` 3,950 · `public.js` 3,301 · `gcr.js` 2,762 · `admin-platform.js` 2,224 · `platform.js` 2,186 · `tourist.js` 1,998 · `email-parser.js` 1,467 · `update-link.js` 1,376 · `menu-editor.js` 1,048 |
| 13 libs · 2 middleware · 11 utils · 2 extractors | ✓ |
| The full mount map, §1.7 | ✓ — 71 live `mount()` calls, 8 commented out, each with the reason the blueprint quotes |
| Duplicate mounts: `/api/admin/gcr` ×2, `/api/webhooks` ×2, `/api/email-parser` ×2 (L374–375) | ✓ |
| Appendix A carryover bug: `gcr.js` `meeting_points` still selects `lat,lng` | ✓ — still present at `routes/gcr.js:308` |
| Every route/lib/util/middleware/extractor file appears somewhere in the document | ✓ — zero misses |

---

## 2. Errors found

### 2.1 §7 wrongly declares two files dead

> **§7:** "Orphaned route files (present in `routes/`, never mounted anywhere):
> `availability-engine.js` (324L) and `capabilities.js` (512L). **Genuinely dead**
> — no require for either exists in `server.js`."

The premise is right and the conclusion is wrong. They are not *mounted*, but
they are required as libraries by three call sites:

```
routes/admin-platform.js:1131   const AVAIL = require('./availability-engine')
routes/admin-platform.js:1628   const CAP   = require('./capabilities')
routes/embed.js:30              const AVAIL = require('./availability-engine')
```

They are load-bearing. Deleting either takes out the operator console's
capability editor, `/match`, and the public embed widget.

This also contradicts the blueprint's own Appendix K, which correctly calls them
*"the two most thesis-defining engines in the API"* and *"the load-bearing
intelligence under the operator console and the embed widget."* §7 and Appendix K
cannot both be right; Appendix K is.

**Fix:** move both out of §7's dead list. They are libraries that happen to live
in `routes/` — arguably they belong in `lib/`, which is likely the source of the
confusion.

### 2.2 Appendices J and K give the wrong path

Both refer to `lib/capabilities.js` and `lib/availability-engine.js`. Neither
exists. The files are `routes/capabilities.js` and `routes/availability-engine.js`.
`lib/` contains 13 files and neither is among them.

---

## 3. Omission: `lib/serviceArea.js` (218 lines) has no §4 entry

The file is listed in §11's honesty ledger as read in full, and its *behaviour*
is described in Appendix L.1 (*"`isInServiceArea` (the 25-mile coastal strip, New
Orleans → Mexico Beach)"*), but it never gets an entry in §4 "Core shared
libraries". The §4 roster is therefore 12 of 13 libs.

It deserves one. It is the geographic half of the counterfeit gate, consumed by
two routes:

```
routes/business-auth.js:34   const { isInServiceArea, SERVICE_AREA_MILES } = require('../lib/serviceArea')
routes/google-business.js:31 const { isInServiceArea } = require('../lib/serviceArea')
```

Its header argues its own design, in the same voice as the rest of the codebase:
GCR covers *the coastline, not a region*, so the service area is a strip drawn
along ~22 anchor points between New Orleans and Mexico Beach rather than a radius
— *"Panama City is 115 miles from Orange Beach. A circle wide enough to reach it
reaches just as far north — pulling in Montgomery, Dothan and half of inland
Alabama."* A point list rather than a polygon because it needs no geo extension,
is readable, and *"adding a town is one line."* `google-business.js:578` uses it
to set `entity.listed_on_gcr` during profile sync.

---

## 4. The gap: no coverage of the deployment / config / verification layer

The blueprint documents ~52,800 lines of application JavaScript exhaustively and
never opens `vercel.json`, `package.json`, `.env.example`, `sql/`, or the guard
scripts. §7 sweeps them into "37 root scaffolding scripts, migrations, and SQL"
and moves on. That is ~4,300 lines of operationally load-bearing material with no
entry anywhere.

### 4.1 `vercel.json` — four scheduled crons, undocumented as schedules

The blueprint mentions the cron *endpoints* in passing (`/cron/reminders`,
*"`GET /ical-import/run` — the hourly Vercel cron"*) but never lists what is
actually scheduled or how often:

| Path | Schedule |
|---|---|
| `/api/platform/cron/reminders` | `0 * * * *` — hourly |
| `/api/gcr/deep-crawl/run` | `*/30 * * * *` — every 30 min |
| `/api/email-parser/ical-import/run` | `0 * * * *` — hourly |
| `/api/transportation/expire` | `*/5 * * * *` — every 5 min |

The deep-crawl and transportation crons are not mentioned as scheduled work
anywhere in the document. Given that HEAD's own commit is *"Stop the runaway
image-liveness cron from the one path still answering"*, the set of things this
API runs on a timer is exactly the kind of fact the blueprint exists to record.

### 4.2 `package.json` — the verification chain and a build hook

```
"verify":       check:sql && check:columns && test:mcp && test:concierge
"vercel-build": node scripts/stop-image-cron.mjs
```

`vercel-build` runs on **every deploy** and is the mechanism behind HEAD's commit
subject. Runtime dependencies are 13: `@anthropic-ai/sdk`, `@supabase/supabase-js`,
`axios`, `bcrypt`, `cors`, `dotenv`, `express`, `express-rate-limit`,
`firebase-admin`, `jsonwebtoken`, `multer`, `stripe`, `twilio`.

### 4.3 The guard scripts — ~1,150 lines with one passing mention

| Script | Lines | Role |
|---|---|---|
| `scripts/test-mcp.js` | 522 | 27 checks — MCP protocol + scoping, no credentials or network |
| `scripts/test-concierge.js` | 397 | the shared concierge-tools suite |
| `scripts/check-capability-columns.mjs` | 100 | fails the build if `capabilities.js` names a column `sql/capability_tables.sql` doesn't create |
| `scripts/verify-db-connection.mjs` | 91 | says which database the API is actually talking to |
| `scripts/check-sql-safety.mjs` | 60 | SQL safety gate |
| `scripts/stop-image-cron.mjs` | 82 | runs on every Vercel build |

Only `check-capability-columns.mjs` gets a mention (one clause in Appendix K).
`check-sql-safety.mjs` and both test suites — the things `npm run verify` runs and
`CLAUDE.md` points at — appear nowhere.

### 4.4 The SQL layer — 3,029 lines of DDL

`schema.sql` (662) · 13 files in `sql/` (1,846) · 3 in `migrations/` (254) ·
1 in `supabase/migrations/` (6) · `TOURIST_TABLES.sql` + `TOURIST_SCHEMA_EXTENSIONS.sql`
(246) · `admin_users_setup.sql` (12).

`sql/capability_tables.sql` (520) is the schema `lib`-level `capabilities.js` is
mechanically checked against — the blueprint describes the check but never the
file it checks against.

### 4.5 `.env.example`

Genuinely documentary rather than a variable list: it records Composio's billing
model (per call, not per connected business; free tier 20,000/month), that Google
Business Profile API access *"has an approval process measured in weeks, so apply
before you need it"*, that rotating `OAUTH_TOKEN_ENCRYPTION_KEY` makes every
stored token unreadable and forces every business to reconnect, and that
`GCR_SERVICE_AREA_MILES` tunes `lib/serviceArea.js`.

---

## 5. Minor count discrepancies

| Blueprint | Actual | Note |
|---|---|---|
| "75 route files (`routes/` + `routes/gcr/`)" | **76** | 75 in `routes/` + `routes/gcr/deep-crawl.js` |
| "174 files on disk" | **198** | excluding `node_modules` and `.git` |
| "~59,367 lines of JS" | **59,034** | 0.6% high |

All three are cosmetic. The per-file counts, which are what the document actually
reasons from, are correct.

---

## 6. Suggested edits, in priority order

1. **Move `routes/capabilities.js` and `routes/availability-engine.js` out of §7's
   dead list** and note their three require sites. This is the only error that
   could cause harm — §7 reads as an invitation to delete them.
2. **Fix the paths in Appendices J and K** — `routes/`, not `lib/`.
3. **Add a §4 entry for `lib/serviceArea.js`.**
4. **Add a section §12 for the deployment layer** — `vercel.json` crons,
   `package.json` scripts, the six guard scripts, the SQL tree, `.env.example`.
5. Correct the three counts in the scope line.

Everything else in the document stands as written.
