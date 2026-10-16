# Paperclip tenancy map (read-only, paperclip-ng @ codex/nextgent-integration-20261005)
Paths are relative to paperclip-ng/ unless noted. Routes are mounted under /api.

## Existing features
| feature | file:line | API route | UI page |
|---|---|---|---|
| Instance admin bypass | server/src/routes/authz.ts:42,69,111 (`actor.isInstanceAdmin`) | - | /company/settings/instance/access (ui/src/App.tsx:250) |
| Membership roles owner/admin/member | packages/shared/src/constants.ts:971-981 | GET /companies/:id/members (routes/access.ts:4495) | /company/settings/members (App.tsx:166) |
| Invites | routes/access.ts:3445,4150,4191 | /invites/:token, /companies/:id/invites | /company/settings/invites (App.tsx:173) |
| Admin user→company access | routes/access.ts:4683,4756 | /admin/users, /admin/users/:id/company-access | instance access |
| Auth | server/src/auth/better-auth.ts:333,344 | /api/auth/* | - |
| Agents per company | routes/agents.ts:4009,4435,4755 | GET/POST /companies/:id/agents, /agent-hires | agents |
| Built-in agents (reconcile/reset per company) | routes/built-in-agents.ts:148,164,215 | /companies/:id/built-in-agents/:key/... | - |
| Managed agent profiles | routes/managed-agent-profiles.ts:41,48 | /companies/:id/managed-agent-profiles | - |
| Routines (company-scoped) | routes/routines.ts:149,157 | /companies/:id/routines | routines |
| Company export/import (portability) | routes/companies.ts:528,578,1123-1158; services/company-portability.ts, company-portability-agent-selection.ts | /companies/:id/exports, /imports/preview, /imports/apply | /company/export/*, /company/import (App.tsx:179,189) |
| Skills catalog + company skills (fork) | routes/company-skills.ts:290-313,356 | /skills/catalog, /companies/:id/skills, fork-precheck | skills |
| **Store: admin catalog → company install** (kinds plugin,pack,skill,automation,connector,agent,app,layout; access free/plan/grant) | services/store.ts:29,72,103,292; routes/store.ts:144-229 (admin), 254-298 (company) | /store/admin/items(+versions,publish,deploy w/ audience companyIds), /companies/:id/store/:item/install\|enable\|update\|DELETE | /store (App.tsx:200), /company/settings/instance/store (App.tsx:257) |
| Store core menu | routes/store.ts:236-248 | /store/admin/menu, /companies/:id/menu | - |
| **Entitlement: plans + grants per company** | routes/entitlement.ts:42-104; services/entitlement/ | /entitlement/admin/plans, /grants, /companies/:id/plan, /companies/:id/entitlement | (no UI route found in App.tsx) |
| Plugins (instance-level) | routes/plugins.ts:854,1148 | /plugins, /plugins/install | /company/settings/instance/plugins (App.tsx:256) |
| Nextgent bridge | routes/nextgent.ts:144-347 | /companies/:id/business-token, /installs/:installId/token, business-link, devices; signed POST /api/nextgent/receipts\|conversations\|devices/status; /.well-known/jwks.json | - |
| store-pc (sidecar) | /workspace/repo-read/store-pc/README.md:8-11 | own server.js; prepares hermes/openclaw agents per business, enable=reuse, disable=pause, SQLite | - |

## Matt's goal vs. what exists
- Grant by Matt: store admin deploy with audience companies (store.ts:292) + access mode "grant" + entitlement grants. EXISTS.
- Customer self-selects: /companies/:id/store/:item/install (free/plan access). EXISTS.
- Agent/routine templates: store kind "agent"/"automation"/"pack"; plus export/import portability. EXISTS.

## Other app/module registries (outside Paperclip)
| registry | file:line | install path |
|---|---|---|
| Plat-admin module registry | Plat-admin/src/modules/registry.js:11,48-75 (ng-store, ng-core-menu, ng-businesses, ng-users) | static JS list; no per-company install |
| Universal-dashboard catalog | Universal-dashboard-/catalog.json:1-3 | EMPTY (`{"apps":[]}`) |
| cybercheck-orchestrator | db/002_workspace.sql:79 (shared installs); src/kernel/policy.js:69 revokeForInstall({businessId,packageKey}); src/platform.js:7 installFanOut | no packages/ dir; installs keyed businessId+packageKey |
| "gcr module_installs" | not in gcr-*; found App-build-/supabase/migrations/0004_modules_as_data.sql:90 (increment_module_installs counter), App-build-/src/app/dashboard/actions.ts:129 | Supabase listings, counter only |

## Gaps
- Entitlement has API but no UI route in ui/src/App.tsx (not verified in Store pages).
- No verified link between store "app" kind and a separate frontend+backend deploy (menu/QR/song-request apps); check services/store-content.ts / nextgent-store.ts.
- Four separate registries (Paperclip store, Plat-admin, orchestrator, App-build) — no single source; Paperclip store is the most complete (kinds+access+audience+install lifecycle).
- Not verified: whether store install of kind "agent" calls agent creation (services/store.ts install path) vs store-pc doing it.

## Gap resolution (2026-10-16, lookup only)
Install flow: routes/store.ts:260 → services/store.ts:599 install(): assertEntitled (plan/grant, :608) → insert store_installs → bringUp (:164): applyToCompany (plugin on) → content.sync → bridge.activate (gcr-api-clean) → automations.install if kind=automation.
- content.sync (store-content.ts:513): every kind except plugin (:282). Imports payload.skills (:520), **creates agent rows via agentSvc.create** (syncAgent :426, loop :528), creates routines and triggers (:490,501), and records each in store_install_resources. So 'agent' (and pack/automation) DO create company agents/routines/skills, taken from the release payload.
- 'app'/'layout' = "projected" kinds (nextgent-store.ts:38). The app manifest (App-build- engine, store-content.ts:77,195; screens/actions/bindings) is pushed to gcr-api-clean via gcr.install (:352), patched on update (:402), and removed on uninstall (:424). gcr-api-clean issues a scoped per-install token, which Paperclip stores as a secret (storeInstallToken :246, store_installs.tokenSecretId). No external URL/iframe field exists; the app is rendered from its manifest, not hosted separately.
- Per-install session token: POST /companies/:id/installs/:installId/token (routes/nextgent.ts:187-209). Needs a company role, an enabled install and GCR_API_URL+NEXTGENT_SERVICE_SECRET. Returns {token, expiresAt} from gcr.installSession, and the token goes no-store to the caller.

| gap | evidence | smallest next step |
|---|---|---|
| store-pc does not react to Paperclip store installs; it runs its own /api/store list/enable for ONE company from env | store-pc/server.js:29-38,66-72 (PAPERCLIP_COMPANY_ID); no webhook/poll found | Put Hermes/OpenClaw agents in Paperclip store items of kind 'agent' (payload.agents with adapter config) so install→content.sync creates them; or run one store-pc per company |
| No entitlement/plan UI anywhere | no 'entitlement' in paperclip-ng/ui/src; Plat-admin src/api/paperclip.js has only store calls | Drive /entitlement/admin/* via API/CLI for now; add a Plat-admin screen later on the same routes |
| Plat-admin wired to store ADMIN routes only (items, versions, publish, retire, menu) | Plat-admin/src/api/paperclip.js:65-73 | Add wrappers for existing /store/admin/items/:id/deploy (audience companies), /installs, /price, plus entitlement grants. Routes exist, so this is wiring only |
| Separate apps (Boxes menu, Play-user song requests) have no per-install token use | no matches for installs/*/token or installSession in Boxes, Play-user, App-build- | App backend: a company user calls POST /api/companies/:id/installs/:installId/token server-side → bearer to gcr-api-clean, scoped to that install's permissions. App must be published as kind 'app' with an App-build manifest |
| External frontend+backend apps don't fit the 'app' kind (manifest-rendered, no URL) | store-content.ts:195 assertAppManifest; no url field | Short term: register as kind 'connector'/'plugin', or put the URL in core menu (store.ts:236) and use the install token above for auth. Otherwise add a URL to the manifest; that is the only new code |
| Install tokens are dead without gcr-api-clean env | nextgent-store.ts:159-173; nextgent.ts:205 (503) | Set GCR_API_URL + NEXTGENT_SERVICE_SECRET on the Paperclip server |
