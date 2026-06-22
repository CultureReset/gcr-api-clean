/**
 * Google Business Profile Integration
 *
 * OAuth 2.0 flow + Google Business Profile API v4
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID          — from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET      — from Google Cloud Console
 *   GOOGLE_REDIRECT_URI       — e.g. https://cybercheck-api-database.vercel.app/api/google-business/callback
 *   OAUTH_TOKEN_ENCRYPTION_KEY — 32-byte hex key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   DASHBOARD_BASE_URL        — e.g. https://cybercheck-login.vercel.app
 *
 * Routes:
 *   GET  /api/google-business/auth               — start OAuth (redirect to Google)
 *   GET  /api/google-business/callback           — handle Google callback
 *   GET  /api/dashboard/google-business/status   — connection status + account info
 *   GET  /api/dashboard/google-business/locations — list business locations
 *   POST /api/dashboard/google-business/select-location — pick which location to use
 *   GET  /api/dashboard/google-business/reviews  — fetch Google reviews
 *   POST /api/dashboard/google-business/reviews/:reviewId/reply — post/update a reply
 *   DELETE /api/dashboard/google-business/reviews/:reviewId/reply — delete reply
 *   POST /api/dashboard/google-business/sync-reviews — import Google reviews to platform
 *   DELETE /api/dashboard/google-business/disconnect — remove connection
 */

const express  = require('express');
const crypto   = require('crypto');
const supabase = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// ─── Google API endpoints ──────────────────────────────────────────────────
const GOOGLE_AUTH_URL    = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL   = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO    = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GBP_ACCOUNTS       = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const GBP_LOCATIONS_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const GBP_REVIEWS_BASE   = 'https://mybusiness.googleapis.com/v4';

const SCOPES = [
    'https://www.googleapis.com/auth/business.manage',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');

// ─── Token encryption (AES-256-GCM) ──────────────────────────────────────
function encryptToken(plaintext) {
    const hexKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || process.env.STRIPE_KEY_ENCRYPTION_KEY;
    if (!hexKey) throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY not set');
    const key    = Buffer.from(hexKey, 'hex');
    const iv     = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decryptToken(stored) {
    const hexKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || process.env.STRIPE_KEY_ENCRYPTION_KEY;
    if (!hexKey) throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY not set');
    const [ivHex, tagHex, encHex] = stored.split(':');
    const key      = Buffer.from(hexKey, 'hex');
    const iv       = Buffer.from(ivHex, 'hex');
    const tag      = Buffer.from(tagHex, 'hex');
    const encBuf   = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encBuf), decipher.final()]).toString('utf8');
}

// ─── Refresh access token when expired ────────────────────────────────────
async function getValidAccessToken(siteId) {
    const { data: row, error } = await supabase
        .from('oauth_tokens')
        .select('access_token, refresh_token, expires_at')
        .eq('site_id', siteId)
        .eq('provider', 'google_business')
        .single();

    if (error || !row) throw new Error('Google Business not connected');

    const accessToken   = decryptToken(row.access_token);
    const refreshToken  = decryptToken(row.refresh_token);
    const expiresAt     = new Date(row.expires_at);

    // Refresh if token expires within 5 minutes
    if (expiresAt > new Date(Date.now() + 5 * 60 * 1000)) {
        return accessToken;
    }

    // Token expired — use refresh token to get a new one
    const params = new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type:    'refresh_token'
    });

    const resp = await fetch(GOOGLE_TOKEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    params.toString()
    });
    const tokens = await resp.json();
    if (!resp.ok || !tokens.access_token) {
        throw new Error('Failed to refresh Google token: ' + (tokens.error_description || tokens.error));
    }

    const newExpiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);
    await supabase.from('oauth_tokens').update({
        access_token: encryptToken(tokens.access_token),
        expires_at:   newExpiry.toISOString(),
        updated_at:   new Date().toISOString()
    }).eq('site_id', siteId).eq('provider', 'google_business');

    return tokens.access_token;
}

// ─── Helper: call Google API with auto-refresh ─────────────────────────────
async function gbpFetch(siteId, url, options = {}) {
    const token = await getValidAccessToken(siteId);
    const res = await fetch(url, {
        ...options,
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type':  'application/json',
            ...(options.headers || {})
        }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error?.message || 'Google API error'), { status: res.status, body });
    return body;
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/google-business/auth
// Starts OAuth — dashboard redirects user here
// Query: ?state=<jwt>&site_id=<uuid>
// ═══════════════════════════════════════════════════════════════════════════
router.get('/auth', (req, res) => {
    const clientId    = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !redirectUri) {
        return res.status(503).send('Google OAuth not configured (missing GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI)');
    }

    // Encode site_id + JWT in state so we know who to attach tokens to after callback
    const statePayload = JSON.stringify({
        site_id:  req.query.site_id  || '',
        jwt:      req.query.jwt      || '',
        return_to: req.query.return_to || ''
    });
    const state = Buffer.from(statePayload).toString('base64url');

    const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: 'code',
        scope:         SCOPES,
        access_type:   'offline',
        prompt:        'consent',           // always get refresh_token
        state
    });

    res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/google-business/callback
// Google redirects here with ?code=...&state=...
// ═══════════════════════════════════════════════════════════════════════════
router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const dashboardUrl = process.env.DASHBOARD_BASE_URL || 'https://cybercheck-login.vercel.app';

    if (error) {
        return res.redirect(`${dashboardUrl}/#connections?google_error=${encodeURIComponent(error)}`);
    }

    let stateData = {};
    try {
        stateData = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    } catch {
        return res.redirect(`${dashboardUrl}/#connections?google_error=invalid_state`);
    }

    const { site_id, return_to } = stateData;
    if (!site_id || !code) {
        return res.redirect(`${dashboardUrl}/#connections?google_error=missing_params`);
    }

    try {
        // Exchange code for tokens
        const tokenParams = new URLSearchParams({
            code,
            client_id:     process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
            grant_type:    'authorization_code'
        });

        const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    tokenParams.toString()
        });
        const tokens = await tokenRes.json();
        if (!tokenRes.ok || !tokens.access_token) {
            throw new Error(tokens.error_description || 'Token exchange failed');
        }

        // Fetch Google user info to get email/name
        const userRes  = await fetch(GOOGLE_USERINFO, {
            headers: { 'Authorization': 'Bearer ' + tokens.access_token }
        });
        const userInfo = await userRes.json();

        // Fetch Google Business accounts to get account ID
        const accountsRes = await fetch(GBP_ACCOUNTS, {
            headers: { 'Authorization': 'Bearer ' + tokens.access_token }
        });
        const accountsBody = await accountsRes.json();
        const firstAccount = accountsBody.accounts?.[0];

        const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

        await supabase.from('oauth_tokens').upsert({
            site_id,
            provider:      'google_business',
            access_token:  encryptToken(tokens.access_token),
            refresh_token: encryptToken(tokens.refresh_token || ''),
            expires_at:    expiresAt.toISOString(),
            account_email: userInfo.email || null,
            account_name:  userInfo.name  || null,
            account_id:    firstAccount?.name || null,    // e.g. "accounts/123456789"
            extra:         { accounts: accountsBody.accounts || [] },
            updated_at:    new Date().toISOString()
        }, { onConflict: 'site_id,provider' });

        // Redirect back to dashboard connections tab with success flag
        const redirectPath = return_to || `${dashboardUrl}/#connections`;
        res.redirect(`${redirectPath}?google_connected=1`);

    } catch (err) {
        console.error('Google OAuth callback error:', err.message);
        res.redirect(`${dashboardUrl}/#connections?google_error=${encodeURIComponent(err.message)}`);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// All routes below require dashboard authentication
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/dashboard/google-business/status
router.get('/status', authRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_email, account_name, account_id, expires_at, extra, updated_at')
        .eq('site_id', req.siteId)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row) return res.json({ connected: false });

    // Check if tokens look valid (not expired)
    const expired = row.expires_at && new Date(row.expires_at) < new Date();

    res.json({
        connected:     !expired,
        account_email: row.account_email,
        account_name:  row.account_name,
        account_id:    row.account_id,
        accounts:      row.extra?.accounts || [],
        updated_at:    row.updated_at
    });
});

// GET /api/dashboard/google-business/locations
// Lists locations under the connected Google Business account
router.get('/locations', authRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id, extra')
        .eq('site_id', req.siteId)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) return res.status(404).json({ error: 'Google Business not connected or no account found' });

    try {
        const data = await gbpFetch(
            req.siteId,
            `${GBP_LOCATIONS_BASE}/${row.account_id}/locations?readMask=name,title,storefrontAddress,websiteUri,regularHours,phoneNumbers`
        );
        res.json({ locations: data.locations || [] });
    } catch (err) {
        console.error('GBP locations error:', err.message);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/dashboard/google-business/select-location
// Save which location this site uses
router.post('/select-location', authRequired, async (req, res) => {
    const { location_name } = req.body;    // e.g. "accounts/123/locations/456"
    if (!location_name) return res.status(400).json({ error: 'location_name required' });

    const { error } = await supabase
        .from('oauth_tokens')
        .update({
            account_id: location_name,
            updated_at: new Date().toISOString()
        })
        .eq('site_id', req.siteId)
        .eq('provider', 'google_business');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, location_name });
});

// GET /api/dashboard/google-business/reviews
// Fetch reviews directly from Google Business Profile
router.get('/reviews', authRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id')
        .eq('site_id', req.siteId)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) return res.status(404).json({ error: 'No Google location selected' });

    try {
        const pageToken = req.query.pageToken || '';
        const url = `${GBP_REVIEWS_BASE}/${row.account_id}/reviews?pageSize=50${pageToken ? '&pageToken=' + pageToken : ''}`;
        const data = await gbpFetch(req.siteId, url);
        res.json({
            reviews:       data.reviews       || [],
            nextPageToken: data.nextPageToken  || null,
            totalReviewCount: data.totalReviewCount || 0,
            averageRating:    data.averageRating    || null
        });
    } catch (err) {
        console.error('GBP reviews error:', err.message);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/dashboard/google-business/reviews/:reviewId/reply
// Post or update a reply to a Google review
router.post('/reviews/:reviewId/reply', authRequired, async (req, res) => {
    const { comment } = req.body;
    if (!comment?.trim()) return res.status(400).json({ error: 'comment required' });

    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id')
        .eq('site_id', req.siteId)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) return res.status(404).json({ error: 'No Google location selected' });

    try {
        const url = `${GBP_REVIEWS_BASE}/${row.account_id}/reviews/${req.params.reviewId}/reply`;
        const data = await gbpFetch(req.siteId, url, {
            method: 'PUT',
            body:   JSON.stringify({ comment: comment.trim() })
        });
        res.json({ success: true, reply: data });
    } catch (err) {
        console.error('GBP reply error:', err.message);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /api/dashboard/google-business/reviews/:reviewId/reply
router.delete('/reviews/:reviewId/reply', authRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id')
        .eq('site_id', req.siteId)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) return res.status(404).json({ error: 'No Google location selected' });

    try {
        const url = `${GBP_REVIEWS_BASE}/${row.account_id}/reviews/${req.params.reviewId}/reply`;
        await gbpFetch(req.siteId, url, { method: 'DELETE' });
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/dashboard/google-business/sync-reviews
// Import Google reviews into the platform reviews table (for website display)
router.post('/sync-reviews', authRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id')
        .eq('site_id', req.siteId)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) return res.status(404).json({ error: 'No Google location selected' });

    try {
        // Fetch up to 50 most recent Google reviews
        const url  = `${GBP_REVIEWS_BASE}/${row.account_id}/reviews?pageSize=50`;
        const data = await gbpFetch(req.siteId, url);
        const googleReviews = data.reviews || [];

        let imported = 0, skipped = 0;

        for (const gr of googleReviews) {
            // Skip reviews with no text
            if (!gr.comment?.trim()) { skipped++; continue; }

            const googleId = gr.reviewId;

            // Check if already imported
            const { data: existing } = await supabase
                .from('reviews')
                .select('id')
                .eq('site_id', req.siteId)
                .eq('google_review_id', googleId)
                .maybeSingle();

            if (existing) { skipped++; continue; }

            const starMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
            await supabase.from('reviews').insert({
                site_id:         req.siteId,
                customer_name:   gr.reviewer?.displayName || 'Google Reviewer',
                rating:          starMap[gr.starRating]   || 5,
                text:            gr.comment.trim(),
                source:          'google',
                google_review_id: googleId,
                owner_reply:     gr.reviewReply?.comment  || null,
                status:          'published',
                created_at:      gr.createTime            || new Date().toISOString()
            });
            imported++;
        }

        res.json({ imported, skipped, total: googleReviews.length });
    } catch (err) {
        console.error('GBP sync-reviews error:', err.message);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /api/dashboard/google-business/disconnect
router.delete('/disconnect', authRequired, async (req, res) => {
    const { error } = await supabase
        .from('oauth_tokens')
        .delete()
        .eq('site_id', req.siteId)
        .eq('provider', 'google_business');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

module.exports = router;
