# MCP — connecting an AI to Gulf Coast Radar

**One API, one deployment, one database.** gcr-api-clean, on the `cyber check`
Supabase project, exactly as before. Nothing here runs anywhere else.

"MCP server" is the protocol's word for an endpoint, not for a machine. There
are two of them and they are two routes in the same Express app, the same way
`/api/gcr` and `/api/admin` are — they share the transport in
`lib/mcpServer.js` and the database client in `db.js`. They exist separately
because they answer to different callers, not because they run apart.

| | `/api/mcp/public` | `/api/mcp` |
| --- | --- | --- |
| **Who it is for** | one agent that answers for **every** business | one business's own assistant |
| **Auth** | none | `gcr_mcp_…` token |
| **Scope** | every active business, public data | one business, decided by the token |
| **Writes** | no | yes, with a write-scoped token |
| **Use it for** | the phone number, the web chat | a business editing its own menu by text |

If you are building the coast-wide voice agent — one number, any business — you want the public one and you can stop reading after the next section.

---

# 1. The public directory server

`https://gcr-api-clean.vercel.app/api/mcp/public`

**No token. Nothing to provision. Nothing to run first.**

That is the whole setup. Paste the URL into the xAI Voice Agent Builder's remote-MCP field and the agent can answer for every business on the platform.

## Why it is open

Everything it returns is already on the public website. A token would protect nothing and would stop the thing scaling — every new surface would need one issued, stored and rotated. It is read-only, scoped to `is_active` businesses, and cannot write. A rate limit (120 requests/minute per IP, `PUBLIC_MCP_RATE_LIMIT`) stops a scraper walking the directory; it is not a password.

## The seven tools

| Tool | What it answers |
| --- | --- |
| `search_businesses` | "who has crab legs", "red snapper charter" — searches names **and** menus, drinks, trips, fish species, amenities, FAQs, tags |
| `whats_on` | "what's going on tonight", "who has happy hour right now", "live music this weekend" — events, specials and happy hours across **every** business, filtered by time, on the coast's own Central clock |
| `list_categories` | "what is there to do here?" — the platform's category list with counts, and the exact `entity_subtype` values to search with |
| `find_item_prices` | "cheapest dolphin cruise", "margarita under $10" — real rows across menus, drinks, happy hour, offer tiers and retail, sorted low to high |
| `get_business_details` | the full profile page: hours, menu, policies, fees, deposits, refunds, weather rules, team, reviews |
| `check_availability` | today's remaining spots, for businesses that publish it |
| `compare_businesses` | 2–5 side by side on industry facts, prices, fees and policies |

Five of these are not new. `search_businesses`, `get_business_details`, `check_availability`, `find_item_prices` and `compare_businesses` are what the tourist chat already runs on, lifted out of `routes/tourist.js` into `lib/conciergeTools.js` so both use one copy. `whats_on` and `list_categories` were added because the site displays them and nothing else could answer by time or by category. `search_businesses` reaches the same deep index as the website's search bar. Improving the search improves the phone agent, the web chat and the website at the same time.

## The rule that matters on a phone call

The server sends an instruction block on connect whose core is:

> Never state a price, a time, a phone number or a count you did not read from a tool. If a tool says there is no data, say you do not have it and offer the business's number — do not estimate, do not average, do not reason from what is typical.

Every tool cooperates: where data is missing they return an explicit note saying so rather than an empty result the model can paper over. A confident wrong price read aloud sends somebody to the wrong door with the wrong money, and unlike a web page there is nothing on a call for them to double-check against.

## Wiring it up

**xAI Voice Agent Builder** — Remote MCP servers → add:

| Field | Value |
| --- | --- |
| Server URL | `https://gcr-api-clean.vercel.app/api/mcp/public` |
| Label | `gulf_coast_radar` |
| Authorization | *(leave empty)* |

Then take the free provisioned number, or SIP in an existing one. The browser test runs a call without dialling — do that first, it costs nothing.

**SDK / Responses API**, same server:

```json
{
  "model": "grok-4.3",
  "tools": [{
    "type": "mcp",
    "server_label": "gulf_coast_radar",
    "server_url": "https://gcr-api-clean.vercel.app/api/mcp/public"
  }],
  "input": "Where can I get crab legs tonight, and what do they run?"
}
```

## Check it

```bash
curl https://gcr-api-clean.vercel.app/api/mcp/public/info

curl -X POST https://gcr-api-clean.vercel.app/api/mcp/public \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"find_item_prices","arguments":{"query":"crab legs"}}}'
```

No credentials in either command. If the second returns priced rows, the voice agent will too.

---

# 2. The single-business server

`https://gcr-api-clean.vercel.app/api/mcp`

For a business's *own* assistant — "add a lunch special", "what did we take last week". Scoped to one business and able to write, so unlike the public server it needs setup.

## It is not a database MCP server

`routes/mcp.js` and `routes/business-data.js` both call `lib/businessTables.js` for schema discovery, the table allow-list and the column filter. One copy, so a fix for the dashboard is a fix for the AI, and a new table becomes a new section in both with no deploy.

```
client ──► POST /api/mcp ──► lib/businessTables.js ──► Supabase
                             allow-list · column filter ·
                             entity_slug from the token
```

The platform rule holds: only gcr-api-clean talks to the database, including when the caller is a model.

## The security model

One sentence: **no tool takes a business name.** The slug comes from the token. There is no `slug` argument anywhere and adding one would be the bug — the query that runs is always

```sql
update menu_items set … where id = 8821 and entity_slug = 'flora-bama'
                                            ↑ from the token, not the request
```

so a tampered id matches nothing rather than someone else's row.

| Guard | What it stops |
| --- | --- |
| Table allow-list | Section names checked against the live list of `entity_slug` tables. `auth.users` is not one. |
| Column filter | `id`, `entity_slug`, `entity_id`, `site_id`, `created_at`, `updated_at` stripped from every write |
| Token scope | A `read` token is not even shown the three write tools in `tools/list` |
| Hashed at rest | Only `sha256(token)` stored; RLS on, no grants to `anon` or `authenticated` |

## The seven tools

`whoami` · `list_sections` · `describe_section` · `read_section` · `create_row` · `update_row` · `delete_row`

A "section" is one table of the business's data. Which exist differs per business, so `list_sections` comes first and `describe_section` before any write.

## Setup

**Once per database** — against the **cyber check** project (`mkepugvdlktfsossumox`):

```bash
psql "$DATABASE_URL" -f sql/business_mcp_tokens.sql
```

**Then mint a token.** Sign in to the business dashboard and take the session token from the browser console:

```js
JSON.parse(localStorage.getItem('gcr_business_session_v1')).access_token
```

```bash
curl -X POST https://gcr-api-clean.vercel.app/api/mcp/tokens \
  -H "Authorization: Bearer $SESSION" -H "Content-Type: application/json" \
  -d '{"label":"Grok","scope":"read"}'
```

The `gcr_mcp_…` it returns is shown once and does not expire. Start with `read`; mint a `write` one when you have watched it work.

```
GET    /api/mcp/tokens        list this business's tokens
DELETE /api/mcp/tokens/:id    revoke one
```

**Then connect**, same as the public server but with `authorization` set to the token. xAI adds the `Bearer` prefix; this server also accepts a bare token, so either way works.

---

# Transport (both servers)

Streamable HTTP: one `POST` carrying JSON-RPC 2.0, answered with a plain JSON body. No SSE channel, no session ids. `lib/mcpServer.js` implements it once for both.

That is a decision, not a gap. This runs on Vercel serverless, where a long-lived connection is killed mid-flight — the same thing that killed the Composio sync. Every method implemented here answers immediately, so the stream would buy nothing and cost reliability. `GET` returns `405`, which is the signal a client needs to fall back to plain POST rather than hang waiting for a stream that will never open.

Implemented: `initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized`. `resources/list` and `prompts/list` answer empty for clients that ask regardless of advertised capabilities.

# Tests

```
npm run verify         # everything below
npm run test:mcp       # 36 checks — the protocol, the token scoping, the slug scoping
npm run test:concierge # 32 checks — whats_on's day and time filtering, against a fixed clock
```

The MCP stub records the queries the router *builds* rather than running them, so the scoping is asserted rather than assumed: a regression that let a caller name a business would still return a plausible row, but would not build the same query. The concierge stub pins the clock to a Wednesday at 16:00 Central, so "is this happening now" means the same thing at any hour of any real day.

# Adding a tool

**Public:** add to `CONCIERGE_TOOLS` and `runConciergeTool()` in `lib/conciergeTools.js`. It appears on the MCP server and in the tourist chat at once. Read-only, and return an explicit note when there is no data rather than an empty result.

**Business:** add to `TOOLS` and `runTool()` in `routes/mcp.js`. Anything touching business data must go through `section()` (the allow-list) and filter on `caller.slug` — never on anything from `params`.
