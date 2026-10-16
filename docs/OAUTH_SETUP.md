# OAuth (Supabase Auth: Google/GitHub) for the dashboards — draft

Routes: `GET /api/oauth/authorize`, `POST /api/oauth/exchange`, `GET /api/oauth/providers` (routes/oauth.js).
Renew/sign-out reuse `/api/business-auth/refresh` and `/signout`.

Admin access for a Supabase/OAuth session (middleware/supabaseSession.js):
row in `platform_admins(user_id)` OR verified email in `admin_users` with role `admin`;
optionally narrowed by `OAUTH_ADMIN_EMAILS`.

Env (optional): `OAUTH_PROVIDERS` (default google,github), `OAUTH_REDIRECT_ORIGINS` (adds to defaults),
`OAUTH_ADMIN_EMAILS`, `GCR_SUPABASE_ANON_KEY` (apikey for the PKCE exchange; falls back to service key),
`SUPABASE_SESSION_CACHE_MS` (default 30000).
