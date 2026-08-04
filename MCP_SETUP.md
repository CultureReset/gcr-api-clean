# MCP — connecting an AI assistant to a business

`https://gcr-api-clean.vercel.app/api/mcp`

An MCP server that lets an outside AI — Grok, or any MCP client — read and edit
**one business's** data by talking to it. No integration per tool, no per-table
endpoint, no database credentials anywhere but this API.

---

## What it is not

It is **not** a database MCP server. Nothing here holds a Postgres connection
or the Supabase service key on the model's behalf.

It is an MCP wrapper over the same handlers the dashboard uses. `routes/mcp.js`
and `routes/business-data.js` both call `lib/businessTables.js` for schema
discovery, the table allow-list and the column filter — one copy, so a fix for
the dashboard is a fix for the AI, and a new table in the database becomes a new
section in both with no deploy.

The platform rule holds: **only gcr-api-clean talks to the database**, including
when the caller is a model.

```
Grok  ──►  POST /api/mcp  ──►  lib/businessTables.js guards  ──►  Supabase
           (JSON-RPC)          allow-list · column filter ·
                               entity_slug from the token
```

---

## The security model

Identical to the dashboard's, and it is one sentence:

> **No tool takes a business name. The slug comes from the token.**

There is no `slug` argument on any tool, and adding one would be the bug. A
model asked to "check the other restaurant's prices" has nothing it can send to
do it — the update that runs is always

```sql
update menu_items set … where id = 8821 and entity_slug = 'flora-bama'
                                            ↑ from the token, not the request
```

On top of that:

| Guard | What it stops |
| --- | --- |
| Table allow-list | The section name is checked against the live list of `entity_slug` tables. `auth.users` is not one. |
| Column filter | `id`, `entity_slug`, `entity_id`, `site_id`, `created_at`, `updated_at` are stripped from every write. A business cannot reassign its own row to another slug. |
| Token scope | A `read` token is not even *shown* the three write tools in `tools/list`. |
| Hashed at rest | Only `sha256(token)` is stored. The table has RLS on and no grants to `anon` or `authenticated`. |

---

## The tools

Seven, deliberately — a model does better picking between a few general tools
and a section name it looked up than between a hundred near-identical ones. And
a new table needs no new tool.

| Tool | Scope | What it does |
| --- | --- | --- |
| `whoami` | read | Which business this connection acts as, and whether it may write |
| `list_sections` | read | Every section with data, and a row count for each |
| `describe_section` | read | One section's columns, types, and which are editable |
| `read_section` | read | Rows, with optional text search and paging |
| `create_row` | write | Add a row; the slug is stamped automatically |
| `update_row` | write | Change named columns of one row by id |
| `delete_row` | write | Remove one row by id |

A "section" is one table of the business's data — `menu_items`, `faqs`,
`events`, `hours`. Which exist differs per business, which is why
`list_sections` comes first.

---

## Setup

### 1. The table

Once per database:

```bash
psql "$DATABASE_URL" -f sql/business_mcp_tokens.sql
```

*(Already applied to the `gulf coast radar` project.)*

### 2. Mint a token

Signed in as the business owner (or as an admin with `?slug=`):

```bash
curl -X POST https://gcr-api-clean.vercel.app/api/mcp/tokens \
  -H "Authorization: Bearer $DASHBOARD_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"Grok assistant","scope":"write"}'
```

```json
{
  "id": "…",
  "label": "Grok assistant",
  "scope": "write",
  "token": "gcr_mcp_9f3a…",
  "note": "Copy this now — it is not stored and cannot be shown again."
}
```

Start with `"scope":"read"`. Move to `write` once you have watched it work.

Managing them:

```
GET    /api/mcp/tokens        list this business's tokens (hashes never returned)
DELETE /api/mcp/tokens/:id    revoke one
```

### 3. Point Grok at it

Remote MCP tools are supported on the xAI SDK, the OpenAI-compatible Responses
API, and the Voice Agent / speech-to-speech API — so the same server backs both
"text your tools" and "call the dashboard".

```json
{
  "model": "grok-4.3",
  "tools": [
    {
      "type": "mcp",
      "server_label": "gulf_coast_radar",
      "server_url": "https://gcr-api-clean.vercel.app/api/mcp",
      "authorization": "gcr_mcp_9f3a…"
    }
  ],
  "input": "What's on our happy hour menu right now?"
}
```

`authorization` takes the **raw token** — xAI adds the `Bearer` prefix. (This
server accepts it either way, so a client that sends the bare token still
works.)

> Field names above are from xAI's remote-MCP docs; check
> <https://docs.x.ai/docs/guides/tools/remote-mcp-tools> for the current shape —
> the docs host refuses automated fetches, so this was not verified against the
> live page.

### 4. Check it before you wire it up

```bash
# No auth — is the server there?
curl https://gcr-api-clean.vercel.app/api/mcp/info

# With a token — what does it think it is?
curl -X POST https://gcr-api-clean.vercel.app/api/mcp \
  -H "Authorization: Bearer gcr_mcp_9f3a…" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"whoami","arguments":{}}}'
```

---

## Transport

Streamable HTTP: one `POST` carrying JSON-RPC 2.0, answered with a plain JSON
body. No SSE channel and no session ids.

That is a decision, not a gap. This runs on Vercel serverless, where a
long-lived connection is killed mid-flight — the same thing that killed the
Composio sync. Stateless request/response is the part of the transport that
survives there, and every method this server implements answers immediately, so
nothing is lost. `GET /api/mcp` returns `405` rather than hanging, which is the
signal a client needs to fall back to plain POST.

Implemented: `initialize`, `tools/list`, `tools/call`, `ping`,
`notifications/initialized`. `resources/list` and `prompts/list` answer empty
for clients that ask regardless of advertised capabilities.

---

## Voice

The same server. A voice agent is the same tool loop with speech on the front —
the transcript goes in, `tools/call` runs against real rows, the answer comes
back as audio. Nothing below the transport changes, which is the point of
putting the tools behind MCP instead of behind a chat endpoint.

---

## Adding a tool

Add an entry to `TOOLS` and a `case` to `runTool()` in `routes/mcp.js`. Anything
touching business data must go through `section()` (the allow-list) and filter
on `caller.slug` — never on anything from `params`.
