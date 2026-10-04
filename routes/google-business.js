/**
 * Google Business Profile Integration
 *
 * OAuth 2.0 flow + Google Business Profile API v4
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID          — from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET      — from Google Cloud Console
 *   GOOGLE_REDIRECT_URI       — <API_BASE_URL>/api/google-business/callback
 *   NEXTGENT_SECRETS_KEY      — tokens are sealed by lib/secretBox.js
 *   OAUTH_TOKEN_ENCRYPTION_KEY — only to read tokens stored before that (old format)
 *   DASHBOARD_BASE_URL        — where Google sends the owner back (else OWNER_APP_URL)
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
const jwt      = require('jsonwebtoken');
const supabase = require('../db');
const { ownerRequired } = require('../middleware/ownerAuth');
const { isInServiceArea } = require('../lib/serviceArea');

const router = express.Router();

// ─── Google API endpoints ──────────────────────────────────────────────────
const GOOGLE_AUTH_URL    = API.auth();
const GOOGLE_TOKEN_URL   = API.token();
const GOOGLE_USERINFO    = API.userinfo();
const GBP_ACCOUNTS       = API.accounts();
const GBP_LOCATIONS_BASE = API.info();
const GBP_REVIEWS_BASE   = API.v4();

// What we ask Google for. The original asked for five fields and no
// coordinates, which left out the one thing that matters most: latlng decides
// whether a business falls inside the coastal service area, and metadata.placeId
// is the key to Places photos and ratings. Asking for it all costs the same
// call, so ask once and map the lot.
const LOCATION_READ_MASK = [
    'name', 'title', 'storefrontAddress', 'websiteUri', 'phoneNumbers',
    'regularHours', 'specialHours', 'categories', 'profile', 'latlng',
    'metadata', 'openInfo', 'serviceArea',
].join(',');

const SCOPES = [
    'https://www.googleapis.com/auth/business.manage',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');

// Token storage, refresh and the authorised fetch live in one place,
// lib/googleBusinessApi.js, shared with the push queue (lib/googlePush.js).
const { API, encryptToken, gbpFetch } = require('../lib/googleBusinessApi');

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/google-business/auth
// Starts OAuth — dashboard redirects user here
// ═══════════════════════════════════════════════════════════════════════════
// POST /api/google-business/start   → { auth_url }
//
// The business is signed in here, so the slug comes from its session and is
// signed into the state Google hands back. It is NOT read from a query
// parameter: /auth used to take ?site_id=, which meant anyone could start a
// connection against any business and have the tokens filed under it.
//
// A redirect cannot carry an Authorization header, which is why this is a
// separate authenticated call that returns the URL for the browser to visit
// rather than a redirect of its own.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/start', ownerRequired, (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !redirectUri) {
        return res.status(503).json({
            error: 'Google is not configured on this server.',
            hint: 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.',
        });
    }

    // Signed with JWT_SECRET and short-lived, so the slug cannot be swapped in
    // flight and a captured link cannot be replayed later.
    const state = jwt.sign(
        { slug: req.entitySlug, return_to: req.body?.return_to || '' },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
    );

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',           // always get refresh_token
        state,
    });

    res.json({ auth_url: `${GOOGLE_AUTH_URL}?${params.toString()}` });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/google-business/callback
// Google redirects here with ?code=...&state=...
// ═══════════════════════════════════════════════════════════════════════════
router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const dashboardUrl = (process.env.DASHBOARD_BASE_URL || process.env.OWNER_APP_URL || '').replace(/\/+$/, '');

    if (error) {
        return res.redirect(`${dashboardUrl}/#connections?google_error=${encodeURIComponent(error)}`);
    }

    // Verify rather than decode. An unsigned state is a slug anyone can edit.
    let stateData;
    try {
        stateData = jwt.verify(state, process.env.JWT_SECRET);
    } catch {
        return res.redirect(`${dashboardUrl}/#connections?google_error=invalid_state`);
    }

    const { slug, return_to } = stateData;
    if (!slug || !code) {
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
            entity_slug: slug,
            provider:      'google_business',
            access_token:  encryptToken(tokens.access_token),
            refresh_token: encryptToken(tokens.refresh_token || ''),
            expires_at:    expiresAt.toISOString(),
            account_email: userInfo.email || null,
            account_name:  userInfo.name  || null,
            account_id:    firstAccount?.name || null,    // e.g. "accounts/123456789"
            extra:         { accounts: accountsBody.accounts || [] },
            updated_at:    new Date().toISOString()
        }, { onConflict: 'entity_slug,provider' });

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
router.get('/status', ownerRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_email, account_name, account_id, expires_at, extra, updated_at')
        .eq('entity_slug', req.entitySlug)
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
router.get('/locations', ownerRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id, extra')
        .eq('entity_slug', req.entitySlug)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) return res.status(404).json({ error: 'Google Business not connected or no account found' });

    try {
        const data = await gbpFetch(
            req.entitySlug,
            `${GBP_LOCATIONS_BASE}/${row.account_id}/locations?readMask=${LOCATION_READ_MASK}`
        );
        res.json({ locations: data.locations || [] });
    } catch (err) {
        console.error('GBP locations error:', err.message);
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/dashboard/google-business/select-location
// Save which location this site uses
router.post('/select-location', ownerRequired, async (req, res) => {
    const { location_name } = req.body;    // e.g. "accounts/123/locations/456"
    if (!location_name) return res.status(400).json({ error: 'location_name required' });

    const { error } = await supabase
        .from('oauth_tokens')
        .update({
            account_id: location_name,
            updated_at: new Date().toISOString()
        })
        .eq('entity_slug', req.entitySlug)
        .eq('provider', 'google_business');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, location_name });
});

// GET /api/dashboard/google-business/reviews
// Fetch reviews directly from Google Business Profile
router.get('/reviews', ownerRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id')
        .eq('entity_slug', req.entitySlug)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) return res.status(404).json({ error: 'No Google location selected' });

    try {
        const pageToken = req.query.pageToken || '';
        const url = `${GBP_REVIEWS_BASE}/${row.account_id}/reviews?pageSize=50${pageToken ? '&pageToken=' + pageToken : ''}`;
        const data = await gbpFetch(req.entitySlug, url);
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
router.post('/reviews/:reviewId/reply', ownerRequired, async (req, res) => {
    const { comment } = req.body;
    if (!comment?.trim()) return res.status(400).json({ error: 'comment required' });

    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id')
        .eq('entity_slug', req.entitySlug)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) return res.status(404).json({ error: 'No Google location selected' });

    try {
        const url = `${GBP_REVIEWS_BASE}/${row.account_id}/reviews/${req.params.reviewId}/reply`;
        const data = await gbpFetch(req.entitySlug, url, {
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
router.delete('/reviews/:reviewId/reply', ownerRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id')
        .eq('entity_slug', req.entitySlug)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) return res.status(404).json({ error: 'No Google location selected' });

    try {
        const url = `${GBP_REVIEWS_BASE}/${row.account_id}/reviews/${req.params.reviewId}/reply`;
        await gbpFetch(req.entitySlug, url, { method: 'DELETE' });
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST /api/dashboard/google-business/sync-reviews
// Import Google reviews into the platform reviews table (for website display)
router.post('/sync-reviews', ownerRequired, async (req, res) => {
    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id')
        .eq('entity_slug', req.entitySlug)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) return res.status(404).json({ error: 'No Google location selected' });

    try {
        // Fetch up to 50 most recent Google reviews
        const url  = `${GBP_REVIEWS_BASE}/${row.account_id}/reviews?pageSize=50`;
        const data = await gbpFetch(req.entitySlug, url);
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
                .eq('entity_slug', req.entitySlug)
                .eq('google_review_id', googleId)
                .maybeSingle();

            if (existing) { skipped++; continue; }

            const starMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
            await supabase.from('reviews').insert({
                entity_slug:     req.entitySlug,
                customer_name:   gr.reviewer?.displayName || 'Google Reviewer',
                rating:          starMap[gr.starRating]   || 5,
                text:            gr.comment.trim(),
                source:          'google',
                google_review_id: googleId,
                owner_reply:     gr.reviewReply?.comment  || null,
                status:          'published',
                created_at:      gr.createTime            || new Date().toISOString()
            });
            await require('../lib/businessEvents').reviewReceived(req.entitySlug, {
                source: 'google', google_review_id: googleId, reviewer_name: gr.reviewer?.displayName || null,
                rating: starMap[gr.starRating] || null, text: gr.comment.trim(),
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
router.delete('/disconnect', ownerRequired, async (req, res) => {
    const { error } = await supabase
        .from('oauth_tokens')
        .delete()
        .eq('entity_slug', req.entitySlug)
        .eq('provider', 'google_business');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/google-business/sync-profile
//
// Pull the selected location and write it onto the entity. This is the payoff
// for connecting: a business that authorises Google gets its address, phone,
// website, hours and coordinates filled in without typing any of it.
//
// Two things make it worth more than a form:
//
//   verification    Google made them prove the address by postcard, phone or
//                   video before they could control the profile. Reaching this
//                   route at all is evidence the business is real and theirs.
//   coordinates     latlng is what decides whether they fall inside the
//                   coastal service area, so listing on GCR stops being a
//                   guess from a typed city name.
//
// Only ever fills gaps by default. A business that has already written its own
// description should not have Google overwrite it — pass overwrite:true to
// take Google's version for every field.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/sync-profile', ownerRequired, async (req, res) => {
    const slug = req.entitySlug;
    const overwrite = req.body?.overwrite === true;

    const { data: row } = await supabase
        .from('oauth_tokens')
        .select('account_id')
        .eq('entity_slug', slug)
        .eq('provider', 'google_business')
        .maybeSingle();

    if (!row?.account_id) {
        return res.status(404).json({
            error: 'No Google Business location is selected yet.',
            hint: 'Connect Google Business, then choose which location this is.',
        });
    }

    try {
        const loc = await gbpFetch(slug, `${GBP_LOCATIONS_BASE}/${row.account_id}?readMask=${LOCATION_READ_MASK}`);

        const addr = loc.storefrontAddress || {};
        const lat = loc.latlng?.latitude ?? null;
        const lng = loc.latlng?.longitude ?? null;

        const fromGoogle = {
            name: loc.title || null,
            phone: loc.phoneNumbers?.primaryPhone || null,
            website_url: loc.websiteUri || null,
            city: addr.locality || null,
            state: addr.administrativeArea || null,
            description: loc.profile?.description || null,
            latitude: lat,
            longitude: lng,
            google_place_id: loc.metadata?.placeId || null,
        };

        const { data: current } = await supabase
            .from('entity')
            .select('name, phone, website_url, city, state, description, latitude, longitude, google_place_id')
            .eq('slug', slug)
            .maybeSingle();
        if (!current) return res.status(404).json({ error: 'No such business' });

        const patch = {};
        const filled = [];
        const kept = [];
        for (const [key, value] of Object.entries(fromGoogle)) {
            if (value === null || value === '') continue;
            const existing = current[key];
            const isEmpty = existing === null || existing === undefined || existing === '';
            if (overwrite || isEmpty) {
                if (existing !== value) { patch[key] = value; filled.push(key); }
            } else if (existing !== value) {
                kept.push(key);
            }
        }

        // Coordinates decide the service area, so recompute it whenever they
        // arrive — including when they only just became known.
        let serviceArea = null;
        if (lat !== null && lng !== null) {
            serviceArea = isInServiceArea({ latitude: lat, longitude: lng, city: fromGoogle.city });
            if (serviceArea.inArea !== null) patch.listed_on_gcr = serviceArea.inArea;
        }

        if (Object.keys(patch).length) {
            const { error } = await supabase.from('entity').update(patch).eq('slug', slug);
            if (error) return res.status(500).json({ error: error.message });
        }

        res.json({
            slug,
            filled,                 // what Google supplied that we did not have
            kept,                   // where the business's own version was left alone
            verified_by_google: true,
            service_area: serviceArea && {
                in_area: serviceArea.inArea,
                miles_to_coast: serviceArea.miles,
                nearest: serviceArea.nearest,
            },
            listed_on_gcr: patch.listed_on_gcr ?? undefined,
        });
    } catch (err) {
        res.status(err.status || 502).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// The push queue (lib/googlePush.js): what is waiting to reach Google, whether
// the profile is verified, the last push, and where Google's copy differs.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/push-status', ownerRequired, async (req, res) => {
    try {
        res.json(await require('../lib/googlePush').status(req.entitySlug));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Push every fact now (queued, then drained by the scheduled check).
router.post('/push-all', ownerRequired, async (req, res) => {
    const push = require('../lib/googlePush');
    const queued = [];
    for (const kind of push.KINDS) if (kind !== 'posts' && (await push.enqueue(req.entitySlug, kind))) queued.push(kind);
    res.status(202).json({ queued });
});

// The scheduled drain: from cron (CRON_SECRET) or the always-on scheduler.
router.get('/cron/drain', require('../lib/cronAuth').cronRequired, async (req, res) => {
    try {
        res.json(await require('../lib/googlePush').drain());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
