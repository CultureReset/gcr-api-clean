# gcr-api-clean

## The database

**Supabase project: `cyber check` — ref `mkepugvdlktfsossumox` (us-west-2).**

That is the only database this API talks to. Every migration, every SQL file in
`sql/`, every `execute_sql` goes there.

There are five other Supabase projects on the same account and one of them is
literally named "gulf coast radar". **It is not the database.** Neither is
"launch gcr". Both hold old copies of `entity` with a couple of thousand rows,
which makes them look right. They are not. Telltales, if you ever need to
check without asking:

| | cyber check (live) | gulf coast radar | launch gcr |
| --- | --- | --- | --- |
| ref | `mkepugvdlktfsossumox` | `adpnhipmdefutkzzltbs` | `xbptmkpbiqzvxptjkfoi` |
| `platform_connections` | yes, ~1,070 rows | absent | absent |
| anon write grants | revoked (0 tables) | 182 tables | 204 tables |

Do not pick a project by name. Confirm by `platform_connections` existing, or
read `SUPABASE_URL` off the Vercel project.

The project's SQL connection times out intermittently through the Supabase MCP
tools. That is a transport problem, not a wrong project — retry rather than
switching to one that answers.

## The architecture rule

Every screen, every app, every AI agent talks to gcr-api-clean, and **only
gcr-api-clean talks to the database.** No dashboard holds a Supabase key. No
MCP server holds one either — `routes/mcp.js` is a wrapper over the same
handlers the dashboard uses, not a database MCP server.

## The slug is never taken from the request

`middleware/ownerAuth.js` resolves which business a caller is from the session
token via `entity_owners`. Handlers filter on `req.entitySlug`, never on
anything in the URL, query string or body. The one exception is an admin, who
must name a slug explicitly and is checked against `platform_admins` first.

Same rule for MCP: which business a token acts as comes from
`business_mcp_tokens`, and no tool takes a slug argument.

## Shared guards

`lib/businessTables.js` holds the schema discovery, the table allow-list and
the column filter. `routes/business-data.js` and `routes/mcp.js` both use it.
One copy — a security check that exists twice drifts until one has a hole.

## Branch

Work goes on `claude/new-session-1e1dj0`.

## Checks

    npm run verify      # sql safety, capability columns, MCP protocol + scoping
    npm run test:mcp    # 27 checks, no credentials or network needed
