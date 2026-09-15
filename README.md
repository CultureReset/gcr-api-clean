# gcr-api-clean

The live API. **This is the only repo that talks to the database** — see
`CLAUDE.md` for the full rule, summarized here because it's the single most
important fact about this repo:

- Supabase project **`cyber check`**, ref `mkepugvdlktfsossumox`. Two other
  Supabase projects on the account ("gulf coast radar", "launch gcr") hold old
  decoy copies of `entity` and are explicitly *not* the database — confirm by
  `platform_connections` existing (~1,070 rows in the real one), not by name.
- No dashboard, no MCP server, nothing else holds a Supabase key.
  `routes/mcp.js` is a wrapper over the same handlers the dashboard uses, not
  a separate database connection.
- The slug is never taken from the request. `middleware/ownerAuth.js`
  resolves which business a caller is from the session token via
  `entity_owners`; handlers filter on `req.entitySlug`. The one exception is
  an admin, checked against `platform_admins` first.
- `lib/businessTables.js` is the one copy of the schema discovery, table
  allow-list and column filter — both `routes/business-data.js` and
  `routes/mcp.js` use it, so the security check exists once, not twice.

**Worth knowing, given what this pass found elsewhere:** several other repos
in this estate (`Api-layer-`, `gcr-api`) are wired directly to the decoy
`launch gcr` project instead of going through this API, and at least three
repos (`check-mate-api-`, `gulf-coast-radar-`, `ghost-ai`) have committed real
credentials for other Supabase projects. None of that touches this repo's own
database — flagged here only because "which repos actually reach the live
database" is exactly the question this repo's CLAUDE.md is trying to settle
estate-wide, and right now the rule isn't universally followed.

## 75 route files, grouped

```
Business data & ownership   business-data.js · business-profile.js · business-auth.js ·
                            auth.js · dashboard.js · team.js · goals.js
Public surface               public.js · site.js · embed.js · gcr.js · gallery.js ·
                            faqs.js · blog.js · deals.js
Booking & availability       bookings.js · availability.js · availability-engine.js ·
                            artist-bookings.js · rentals.js · boat-rental.js ·
                            charter.js · rides.js · transportation.js · fareharbor.js
Menu & QR                    menu-edit.js · menu-editor.js · simple-menu-edit.js · qr.js
Messaging & voice             sms.js · dashboard-sms.js · messaging.js · voice-notes.js ·
                            whatsapp.js · email-parser.js · email-webhook.js ·
                            meta-webhook.js · webhooks.js
AI / MCP / concierge          mcp.js · mcp-public.js · ai-provider.js · composio.js ·
                            capabilities.js
Admin                         admin.js · admin-analytics.js · admin-platform.js ·
                            admin-settings.js · admin-signups.js · admin-tourists.js
Tourist                       tourist.js · tourist-auth.js · tourist-groups.js
Photos                        live-photo.js · rehost-photos.js · ocr.js
Payments                      stripe.js · square.js
Other                         apps.js · ar-hunts.js · artists.js · cooperatives.js ·
                            google-business.js · ingest.js · intake.js · links.js ·
                            modules.js · photographer.js · platform.js ·
                            services.js · setup-questions.js · update-link.js ·
                            user.js · verify-dns.js
```

## lib/ — shared logic that isn't route-specific

```
businessTables.js       schema discovery, table allow-list, column filter — see above
entity-resolver.js · find-existing-entity.js
conciergeTools.js · staff-commands.js · touristMemory.js
mcpServer.js
analyze-photo.js · menu-gcr.js · serviceArea.js · edit-log.js
industry-contract.js · composioClient.js
```

## Checks

```bash
npm run verify       # sql safety, capability columns, MCP protocol + scoping, concierge
npm run test:mcp     # 27 checks, no credentials or network needed
npm run check:sql
npm run check:columns
npm run test:concierge
```

## Run

```bash
npm start   # node server.js
npm run dev # node --watch server.js
```

See `CLAUDE.md` for the full database and architecture rules — this file
summarizes them, `CLAUDE.md` is the source of truth.
