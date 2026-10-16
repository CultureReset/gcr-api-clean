# ONE LOGIN + ALL BACK END ON DIGITALOCEAN — plan (no changes made)

Target (Matt, 2026-10-16): every back-end piece on the DO Droplet (165.22.133.121):
gcr-api-clean (the one API), auth, Paperclip, Jarvis, and eventually the database.
Only the two React dashboards stay on Vercel (admin-dashboard-main, dashboards-users),
and they talk ONLY to the DO API. One login, owned by the DO back end (Paperclip's Better Auth).

## Today (verified 2026-10-16, Central time)
- Droplet: 2 vCPU / 4 GB RAM (~1.5 GB available) / 77 GB disk (52% used). Containers: docker-server-1 (Paperclip, ~1 GB),
  docker-db-1 (Paperclip Postgres), openjarvis (:8000), plat-admin (static, :8080). Nothing on :80/:443, no TLS.
- gcr-api-clean: Vercel (Express via @vercel/node), 5 Vercel crons, Supabase project mkepugvdlktfsossumox
  (service key) for data AND auth (owner sessions via Supabase Auth; admins via admin_users + JWT_SECRET).
- Logins: 3 separate systems: admin_users (info@cybercheckinc.com), Supabase Auth (business owners, platform_admins),
  Paperclip Better Auth (info@cybercheckinc.com = instance_admin, bootstrap ready).
- admin-dashboard-main (Vercel) proxies /api/paperclip/* and /api/jarvis/chat to the Droplet over plain HTTP (sslip.io).

## Target architecture
    Vercel:  admin-dashboard-main  ─┐        dashboards-users ─┐
                                    ▼                          ▼
    DO:      https://api.<domain>   (Caddy, auto TLS; single public entry)
               /api/*            → gcr-api-clean   (container, :3000)
               /api/auth/*,/pc/* → Paperclip        (Better Auth: THE login; :3100, internal only)
               /jarvis/*         → Jarvis proxy route inside gcr-api-clean → openjarvis :8000 (internal only)
             Postgres: Supabase (phase A) → DO Managed Postgres or Droplet Postgres (phase C)
- Close public 3100/8000/8080 in the DO firewall once Caddy fronts them; only 22/80/443 open.
- Dashboards call one base URL: VITE_API_BASE_URL / VITE_GCR_API_BASE = https://api.<domain>.
  The Vercel functions api/paperclip.js and api/jarvis/chat.js are then deleted (the browser talks to DO directly).

## One login design
- Identity provider: Paperclip Better Auth on DO (email+password now; add Google/GitHub social providers
  in Better Auth later, which replaces the Supabase-OAuth draft on branch auth/supabase-oauth; shelve that branch).
- Cookie-free for the cross-site dashboards: Vercel origins ≠ api.<domain>, so third-party cookies are unreliable.
  Use a Bearer token:
  1. Dashboard POSTs /api/auth/sign-in/email to https://api.<domain> (CORS allowlist = the two dashboard origins).
  2. gcr-api-clean exposes POST /api/session/token: calls Paperclip /api/auth/get-session internally with the
     cookie/session, then mints a short-lived (15 min) service JWT {sub: paperclipUserId, email, roles, entitySlugs}
     signed with ONE_LOGIN_JWT_SECRET (or ES256 key; publish JWKS at /.well-known/jwks.json) + refresh via the
     Paperclip session. (Alternative: enable Better Auth's bearer/jwt plugin in Paperclip and verify its JWKS.)
  - Simplest variant if both dashboards move under the same parent domain (admin.<domain>, app.<domain> as Vercel
    custom domains, api.<domain> on DO): first-party cookie with Domain=.<domain>, SameSite=Lax; Better Auth
    crossSubDomainCookies. Recommended: do this, it avoids token plumbing.
- Roles: instance_admin (Paperclip instance_user_roles) = platform admin; business owner = Paperclip user linked to
  entity_owners.entity_slug.

## Changes per repo
- gcr-api-clean
  - Add Dockerfile (node:22-alpine, `node server.js`, PORT 3000), docker-compose service on the Droplet network.
  - Replace Vercel crons (vercel.json) with a cron container or host crontab hitting the 5 /api/... cron paths
    (with a CRON_SECRET header).
  - New middleware/oneLogin.js: verify service JWT (or Paperclip session via internal http://paperclip:3100/api/auth/get-session).
    adminRequired / routes/admin.js authRequired → require role instance_admin. ownerRequired → map Paperclip user → entity_owners.
    Keep legacy admin JWT + Supabase sessions accepted during migration behind LEGACY_AUTH=true, then remove.
  - Move Jarvis proxy here: POST /api/jarvis/chat (adminRequired) → http://openjarvis:8000/v1/chat/completions with OPENJARVIS_API_KEY.
  - CORS: DEFAULT_ORIGINS = the dashboard origins only.
  - Env on Droplet (/opt/gcr-api/.env, chmod 600): everything in the Vercel project env (GCR_SUPABASE_URL/SERVICE_KEY, JWT_SECRET,
    TWILIO_*, BREVO/RESEND, COMPOSIO, SENDBLUE, FIREBASE/private_key, CORS_ORIGINS) + PAPERCLIP_INTERNAL_URL, ONE_LOGIN_JWT_SECRET,
    OPENJARVIS_API_KEY, CRON_SECRET.
- Paperclip (/opt/paperclip/docker/paperclip.env): PAPERCLIP_PUBLIC_URL=https://api.<domain>; add dashboard origins to
  PAPERCLIP_APP_ORIGINS / PAPERCLIP_ALLOWED_HOSTNAMES (+ api.<domain>); optional cross-subdomain cookie config; sign-up disabled
  except via invite (authDisableSignUp) once accounts are migrated.
- admin-dashboard-main: AuthContext signs in via Paperclip only (Plat-admin's AuthContext pattern already exists to copy);
  drop /api/admin/login; client.js sends the one-login token; delete api/paperclip.js + api/jarvis/chat.js; VITE_API_BASE_URL=https://api.<domain>.
- dashboards-users: AuthContext swaps /api/business-auth/* for the Paperclip login (keep phone-code sign-in as a gcr-api-clean
  route that creates/looks up the Paperclip user, then issues the session); VITE_GCR_API_BASE=https://api.<domain>.
- Droplet infra: Caddyfile (api.<domain> reverse proxy, automatic Let's Encrypt), DO firewall (22/80/443), DNS A record
  api.<domain> → 165.22.133.121 (or a Reserved IP).

## Droplet sizing
- Now 4 GB with ~1.5 GB free; adding gcr-api-clean (~200-400 MB) + Caddy fits but is tight with Jarvis.
  Resize to 8 GB / 4 vCPU (CPU+RAM resize, keep disk so it is reversible) before cut-over. If Postgres moves onto the
  Droplet too, 8 GB minimum; prefer DO Managed Postgres instead.

## Database decision
- Phase A–B: STAY on Supabase (mkepugvdlktfsossumox). Lowest risk; gcr-api-clean only needs the service key; Supabase Auth
  stays alive read-only for legacy sessions during migration.
- Phase C (later): move data to DO Managed Postgres (pg_dump/pg_restore of public schema; app uses @supabase/supabase-js
  query builder everywhere, so this needs PostgREST on DO or a rewrite to pg/drizzle — the bigger job; plan separately).
  Storage buckets (photos) → DO Spaces at the same time.

## Account migration
- admin_users (1 row: info@cybercheckinc.com) → already exists in Paperclip as instance_admin. Retire admin_users after cut-over.
- platform_admins (Supabase Auth user ids) → Paperclip instance_admin for each (by email), invite via Paperclip.
- Business owners (Supabase Auth users + entity_owners): script reads auth.users (email/phone) + entity_owners, creates Paperclip
  users (no password; send invite / reset link, or phone-code sign-in), and writes a mapping table
  one_login_users(paperclip_user_id, supabase_user_id, entity_slug). ownerRequired reads entity ownership via that mapping.
  Derived logins (slug@biz.gulfcoastradar.com) keep working as the Paperclip email.

## Phases & cut-over
1. Infra: DNS api.<domain>, Caddy+TLS, resize Droplet, firewall. Paperclip + Jarvis behind Caddy.
2. Deploy gcr-api-clean container on DO alongside Vercel (same Supabase). Smoke test, run crons from DO, disable Vercel crons.
3. One-login middleware in gcr-api-clean (legacy accepted). Admin dashboard → Paperclip login. Then user dashboard.
4. Migrate owners, switch dashboards' base URL to api.<domain>, remove Vercel functions, set gcr-api-clean Vercel project to
   pause (keep 2 weeks for rollback), turn LEGACY_AUTH off.
5. (Later) DB to DO Postgres + Spaces.
Rollback at each step: dashboards' base URL env back to https://gcr-api-clean.vercel.app; re-enable Vercel crons.

## Open questions for Matt
- Domain for api.<domain> (and optionally admin./app. custom domains on Vercel for first-party cookies).
- OK to resize Droplet (cost) and to use DO Managed Postgres later vs. self-hosted.
- Keep phone-code sign-in for owners? (needs Twilio on DO, already in env.)
