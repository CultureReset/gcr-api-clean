// ============================================================
// OAUTH SIGN-IN (Supabase Auth: Google, GitHub) for both dashboards
// ============================================================
//
//   GET  /api/oauth/authorize?provider=google&redirect_to=<dashboard url>&code_challenge=<S256>
//        → 302 to Supabase's /auth/v1/authorize (PKCE)
//   POST /api/oauth/exchange { auth_code, code_verifier }
//        → { session } — same shape as /api/business-auth/* sessions
//
// The browser generates the PKCE verifier and keeps it; this API only ever
// sees the verifier at exchange time. No Supabase URL or key reaches the
// bundle. Renewal and sign-out reuse /api/business-auth/refresh and /signout.
//
// Two allowlists guard redirect_to: OAUTH_REDIRECT_ORIGINS here, and the
// "Redirect URLs" list in Supabase Auth settings.

const express = require('express');

const router = express.Router();

const SUPABASE_URL = (process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.GCR_SUPABASE_ANON_KEY || process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const PROVIDERS = (process.env.OAUTH_PROVIDERS || 'google,github')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const DEFAULT_REDIRECT_ORIGINS = [
    'https://admin-dashboard-main.vercel.app',
    'https://admin-dashboard-main-cyber-check.vercel.app',
    'https://dashboards-users.vercel.app',
    'https://dashboards-users-cyber-check.vercel.app',
    'https://dashboard.gulfcoastradar.com',
];
const redirectOrigins = new Set(
    (process.env.OAUTH_REDIRECT_ORIGINS || '')
        .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean)
        .concat(DEFAULT_REDIRECT_ORIGINS),
);
const allowLocalhost = process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production';

function redirectAllowed(raw) {
    let url;
    try { url = new URL(raw); } catch { return false; }
    if (allowLocalhost && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return true;
    return url.protocol === 'https:' && redirectOrigins.has(url.origin);
}

const sessionPayload = (s) => ({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at || (s.expires_in ? Math.floor(Date.now() / 1000) + Number(s.expires_in) : undefined),
    expires_in: s.expires_in,
    token_type: s.token_type || 'bearer',
    user: { id: s.user?.id, email: s.user?.email, provider: s.user?.app_metadata?.provider },
});

router.get('/providers', (_req, res) => res.json({ providers: PROVIDERS }));

router.get('/authorize', (req, res) => {
    const provider = String(req.query.provider || '').toLowerCase();
    const redirectTo = String(req.query.redirect_to || '');
    const challenge = String(req.query.code_challenge || '');

    if (!SUPABASE_URL) return res.status(503).json({ error: 'OAuth is not configured.' });
    if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unknown sign-in provider.' });
    if (!redirectAllowed(redirectTo)) return res.status(400).json({ error: 'That return address is not allowed.' });
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return res.status(400).json({ error: 'Missing PKCE challenge.' });

    const target = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
    target.searchParams.set('provider', provider);
    target.searchParams.set('redirect_to', redirectTo);
    target.searchParams.set('code_challenge', challenge);
    target.searchParams.set('code_challenge_method', 's256');
    if (provider === 'github') target.searchParams.set('scopes', 'read:user user:email');
    res.set('Cache-Control', 'no-store');
    res.redirect(302, target.toString());
});

router.post('/exchange', async (req, res) => {
    const authCode = String(req.body?.auth_code || '').trim();
    const verifier = String(req.body?.code_verifier || '').trim();
    if (!authCode || !verifier) return res.status(400).json({ error: 'Missing sign-in code.' });
    if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(503).json({ error: 'OAuth is not configured.' });

    try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
            method: 'POST',
            headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ auth_code: authCode, code_verifier: verifier }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || !body.access_token) {
            return res.status(401).json({ error: 'That sign-in did not complete. Try again.' });
        }
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, session: sessionPayload(body) });
    } catch (err) {
        console.error('[oauth] exchange failed:', err.message);
        res.status(502).json({ error: 'Could not reach the sign-in service.' });
    }
});

module.exports = router;
module.exports._test = { redirectAllowed };
