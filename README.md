# Force redeploy at Thu May 28 14:07:58 CDT 2026


## Automation builder

Build a trigger + a chain of steps once in the admin console, publish it as a
version, and push that version to every business dashboard (or some). A
business runs the version it was given, never the draft — so editing changes
nothing anywhere until the next publish and push.

| Piece | Where |
|---|---|
| Engine: step catalogue, templating, runner, schedule check, events | `lib/automationEngine.js` |
| Routes: admin builder, owner installs, cron tick, inbound hooks | `routes/automations.js` |
| Tables (applied to the live project) | `sql/automations.sql` |
| Tests, no credentials needed | `npm run test:automations` |

Mounts: `/api/admin/automations` (adminRequired), `/api/business/automations`
(ownerRequired — the slug comes from the session), `/api/automations/cron/tick`
(hourly, from `vercel.json`, guarded by `CRON_SECRET`) and
`/api/automations/hook/:token` (one random token per install).

Step types are the modular part: `data.query`, `data.insert`, `data.update`,
`condition`, `transform`, `script`, `ai.prompt`, `http.request`, `sms.send`,
`email.send`, `notify`, `log`. Adding one is one entry in the engine; both
dashboards read the catalogue from `GET /api/admin/automations/meta`.

The data steps use the same three guards as the dashboard and the MCP server
(`lib/businessTables.js`). `entity_automations` and `automation_runs` carry
`entity_slug` but are held back from schema discovery there, so a business can
never reach them through the generic writer.

To fire an automation from another route: `require('../lib/automationEngine').emitEvent(name, slug, payload)`.
`routes/intake.js` does this for `intake.created`.
