// ============================================================
// BUSINESS SIGN-UP — phone, code, account
// ============================================================
//
// A business creating its own account from scratch. Phone number in, six-digit
// code back, account created.
//
//   POST /api/business-auth/phone     { phone }                  → sends the code
//   POST /api/business-auth/verify    { phone, code }            → confirms it
//   GET  /api/business-auth/similar   ?name=                     → who already exists
//   POST /api/business-auth/register  { phone, code, name, ... } → creates everything
//
// ── This is NOT the tourist system ──────────────────────────────────────
//
// routes/tourist-auth.js does something that looks similar for Trip Swipe
// tourists. It is a different product with a different account model, and the
// two share no code on purpose. This file has its own Twilio client, its own
// credential resolution, and its own routes. Changing one must never move the
// other. Do not merge them.
//
// ── Nothing goes live on its own ────────────────────────────────────────
//
// The public directory has 4,067 real listings in it. Anyone on the internet
// can reach these routes, so a sign-up creates the entity INACTIVE and hidden,
// records it in business_signups with status 'pending', and captures any
// existing listing whose name resembles the one submitted. A human approves
// before it is public. That is the counterfeit gate.

const express = require('express');
const twilio = require('twilio');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const db = require('../db');
const { isInServiceArea, SERVICE_AREA_MILES } = require('../lib/serviceArea');

const router = express.Router();

/* ── minting the browser's session here instead of there ──────────────────
 *
 * The dashboard used to carry the Supabase client itself: this file handed
 * back a one-time secret and the browser redeemed it for a session. That is
 * what required the anon key to be in the bundle, and the anon key in the
 * bundle is what left 78 tables writable by anyone who opened developer tools.
 *
 * So the redemption happens here now. The secret is created, used, and
 * discarded inside this process; the browser is handed the finished session
 * and never sees the credential that produced it.
 *
 * A separate client from ../db on purpose. Signing in mutates a client's own
 * session state, and ../db is the service-key client every other route shares
 * — a sign-in must not be able to move what those routes are acting as.
 */
const authClient = createClient(
    process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
);

/** The session shape the dashboard stores. Deliberately not the whole object. */
const sessionPayload = (session) => ({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type || 'bearer',
    user: { id: session.user?.id, email: session.user?.email },
});

/**
 * Exchange an account label and a password for a session.
 *
 * Used three ways: right after registration, right after a sign-in code, and
 * for the invite accounts that really do have a password the owner chose.
 */
async function mintSession(email, password) {
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error || !data?.session) {
        const err = new Error(error?.message || 'Could not start a session.');
        err.status = 401;
        throw err;
    }
    return sessionPayload(data.session);
}

/**
 * How a phone-only account gets a browser session.
 *
 * The business proves it owns the number by entering the code. There is no
 * password to sign in with, and Supabase has no admin call that mints a phone
 * session the way generateLink() does for email. So the server sets a fresh
 * random secret on the account and hands it back once, over HTTPS, to the
 * client that just passed the code check; the browser signs in with it
 * immediately and Supabase issues the real session.
 *
 * The secret is rotated on every sign-in and never stored anywhere by us, so
 * an old one is worthless the moment the next code is used. The business never
 * sees it or types it — as far as they are concerned the phone IS the login.
 */
const newSessionSecret = () => `${crypto.randomBytes(24).toString('base64url')}Aa1!`;

/**
 * The label Supabase files a phone-only account under.
 *
 * Supabase requires every account to carry a unique identifier, and it accepts
 * either an email or a phone number. Phone accounts need Supabase's own phone
 * provider switched on — it is not, and it should not be, because Twilio Verify
 * already sends the code. So the account is filed under an email-shaped label
 * built from the digits: 12515550100@business.invalid
 *
 * NOT A REAL EMAIL ADDRESS. Nothing is ever sent to it, nobody owns the
 * mailbox, and the business never sees or types it. It exists only so Supabase
 * can tell one account from another.
 *
 * `.invalid` is reserved by RFC 2606 precisely for this: it is guaranteed
 * never to resolve and can never be registered by anyone. That matters — an
 * earlier version of this used a made-up subdomain of a real site, which both
 * implied a mailbox that does not exist and tied these accounts to a domain
 * this product is not served from.
 *
 * The real phone number is kept in user_metadata and on the entity, so it stays
 * queryable and still shows in the dashboard.
 */
const PHONE_LOGIN_DOMAIN = process.env.BUSINESS_PHONE_LOGIN_DOMAIN || 'business.invalid';
const loginEmailFor = (phone) => `${String(phone).replace(/\D/g, '')}@${PHONE_LOGIN_DOMAIN}`;

/* ── Twilio, this file's own ─────────────────────────────────────────────
 *
 * Verify — not Programmable Messaging. Verify sends through Twilio's own
 * verified infrastructure rather than our long code, so it does NOT depend on
 * A2P 10DLC campaign registration. A pending campaign does not block sign-up.
 *
 * Credentials come from env first, then platform_config (service-key only,
 * never exposed to the anon key). The env's TWILIO_ACCOUNT_SID has historically
 * held an API Key SID (SK...) where an Account SID (AC...) belongs, which the
 * constructor rejects outright — so both shapes are tried and the first that
 * authenticates is cached.
 */

let cachedClient = null;
let cachedServiceSid = null;
let configPromise = null;

function platformConfig() {
    if (!configPromise) {
        configPromise = Promise.resolve(
            db.from('platform_config')
                .select('key, value')
                .in('key', ['twilio_account_sid', 'twilio_auth_token', 'twilio_verify_service_sid'])
        )
            .then(({ data }) => Object.fromEntries((data || []).map((r) => [r.key, (r.value || '').trim()])))
            .catch(() => ({}));
    }
    return configPromise;
}

async function client() {
    if (cachedClient) return cachedClient;

    const cfg = await platformConfig();
    const envSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const envTok = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    const dbSid = cfg.twilio_account_sid || '';
    const dbTok = cfg.twilio_auth_token || '';

    const accountSid = dbSid.startsWith('AC') ? dbSid : (envSid.startsWith('AC') ? envSid : '');

    const candidates = [];
    const seen = new Set();
    const add = (sid, tok, opts) => {
        if (!sid || !tok) return;
        const key = `${sid}:${tok}:${opts?.accountSid || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        try { candidates.push(twilio(sid, tok, opts)); } catch { /* malformed pair */ }
    };

    for (const tok of [envTok, dbTok]) {
        if (envSid.startsWith('AC')) add(envSid, tok);
        if (envSid.startsWith('SK') && accountSid) add(envSid, tok, { accountSid });
        if (accountSid) add(accountSid, tok);
    }

    if (!candidates.length) throw new Error('Texting is not configured on this server.');

    for (const candidate of candidates) {
        try {
            await candidate.api.v2010.accounts(candidate.accountSid).fetch();
            cachedClient = candidate;
            return candidate;
        } catch { /* try the next pairing */ }
    }
    throw new Error('Texting is not configured on this server.');
}

async function verifyService() {
    const c = await client();
    if (!cachedServiceSid) {
        const cfg = await platformConfig();
        const fromConfig = [(process.env.TWILIO_VERIFY_SERVICE_SID || '').trim(), cfg.twilio_verify_service_sid || '']
            .find((sid) => sid.startsWith('VA'));
        if (fromConfig) {
            cachedServiceSid = fromConfig;
        } else {
            const services = await c.verify.v2.services.list({ limit: 20 });
            cachedServiceSid = (services[0] || await c.verify.v2.services.create({ friendlyName: 'Gulf Coast Radar' })).sid;
        }
    }
    return c.verify.v2.services(cachedServiceSid);
}

/** E.164, assuming US when no country code is given. */
function normalizePhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
    return `+${digits}`;
}

const looksLikePhone = (p) => /^\+\d{10,15}$/.test(p);

/* ── name matching, for the counterfeit check ────────────────────────────── */

/**
 * Comparable form of a business name: lowercase, no punctuation or filler.
 *
 * Apostrophes are removed rather than turned into spaces, so "LuLu's" becomes
 * "lulus" and matches someone typing "Lulus". Splitting on them instead would
 * produce the tokens "lulu" and "s", which matches neither.
 */
function normalizeName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\b(the|a|an|of|at|on|llc|inc|co|company|restaurant|bar|grill)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 0–1 token overlap, scored against the SHORTER name.
 *
 * This is a surfacing score, not a verdict. "Flora-Bama Boat Tours" scores 1.0
 * against "Flora-Bama" because every word of the shorter name appears in the
 * longer one — which is exactly what a reviewer should see, and exactly what
 * must NOT block a sign-up on its own. A genuinely new business next door to a
 * famous one shares its name and is still a different business.
 */
function similarity(a, b) {
    const left = new Set(normalizeName(a).split(' ').filter(Boolean));
    const right = new Set(normalizeName(b).split(' ').filter(Boolean));
    if (!left.size || !right.size) return 0;
    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    return shared / Math.min(left.size, right.size);
}

/**
 * The same business, not merely a similar one.
 *
 * Blocking needs certainty, so it takes exact equality of the normalised
 * names. "The Flora-Bama Yacht Club LLC" and "Flora-Bama Yacht Club" both
 * reduce to "flora bama yacht club" and are refused; "Flora-Bama Boat Tours"
 * does not reduce to "flora bama" and is allowed through to review.
 */
function isSameName(a, b) {
    const left = normalizeName(a);
    return Boolean(left) && left === normalizeName(b);
}

/**
 * Existing listings that look like this name.
 *
 * Searches on the most distinctive word rather than the whole string, because
 * "Flora-Bama Lounge" and "Flora-Bama" share no exact prefix but are obviously
 * the same business to a reviewer.
 */
async function findSimilar(name, limit = 8) {
    const tokens = normalizeName(name).split(' ').filter((t) => t.length > 2);
    if (!tokens.length) return [];

    const longest = tokens.sort((a, b) => b.length - a.length)[0];
    const { data } = await db
        .from('entity')
        .select('slug, name, city, entity_type, is_active')
        .ilike('name', `%${longest}%`)
        .limit(40);

    return (data || [])
        .map((row) => ({ ...row, score: Number(similarity(name, row.name).toFixed(2)) }))
        .filter((row) => row.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

/* ── routes ──────────────────────────────────────────────────────────────── */

// POST /phone — send a six-digit code.
router.post('/phone', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!looksLikePhone(phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });

    // One pending sign-up per number, checked before spending an SMS.
    const { data: existing } = await db
        .from('business_signups')
        .select('id, entity_slug, status')
        .eq('phone', phone)
        .eq('status', 'pending')
        .maybeSingle();
    if (existing) {
        return res.status(409).json({
            error: 'That number already has a business waiting for review.',
            entity_slug: existing.entity_slug,
        });
    }

    try {
        await (await verifyService()).verifications.create({ to: phone, channel: 'sms' });
    } catch (err) {
        console.error('[business-auth] verify send failed:', err.message);
        return res.status(502).json({ error: 'Could not send the code — try again in a moment.' });
    }
    res.json({ success: true, phone });
});

// POST /verify — confirm the code without committing to anything yet, so the
// UI can move to the next step before asking for a business name.
router.post('/verify', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!looksLikePhone(phone) || !code) return res.status(400).json({ error: 'Phone and code required.' });

    try {
        const check = await (await verifyService()).verificationChecks.create({ to: phone, code });
        if (check?.status !== 'approved') return res.status(400).json({ error: 'That code is not right.' });
    } catch {
        return res.status(400).json({ error: 'That code is not right, or it expired.' });
    }
    res.json({ success: true, phone });
});

// GET /similar?name= — who already looks like this. Public and read-only, so
// the sign-up form can warn before someone types a whole profile.
router.get('/similar', async (req, res) => {
    const name = (req.query?.name || '').trim();
    if (name.length < 3) return res.json({ matches: [] });
    try {
        res.json({ matches: await findSimilar(name) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /register — the code is checked again here, then everything is created.
//
// The code is deliberately re-checked rather than trusted from /verify: that
// route returns nothing an attacker cannot forge, so it is a UX convenience,
// not an authorisation. Twilio Verify allows a second check inside the same
// verification window.
router.post('/register', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    const name = String(req.body?.business_name || '').trim();

    // Email is optional and expected to be blank. It arrives later, when they
    // connect Gmail or Google Business — asking for it here is one more field
    // between a business and an account, for something we get for free.
    const email = (req.body?.email || '').trim().toLowerCase() || null;

    // No password. The phone number is the login; the code proves they own it.
    const sessionSecret = newSessionSecret();

    if (!looksLikePhone(phone) || !code) return res.status(400).json({ error: 'Phone and code required.' });
    if (!name) return res.status(400).json({ error: 'What is the business called?' });

    let authId = null;
    let entityId = null;

    try {
        const check = await (await verifyService()).verificationChecks.create({ to: phone, code });
        if (check?.status !== 'approved') return res.status(400).json({ error: 'That code is not right.' });
    } catch {
        return res.status(400).json({ error: 'That code is not right, or it expired.' });
    }

    try {
        // Who already looks like this. Recorded either way — a reviewer needs
        // to see it, and a near-match is not on its own a reason to refuse.
        const duplicates = await findSimilar(name);

        // The same name on an ACTIVE listing is refused outright: that
        // business exists, and taking it over is the claim flow, which
        // verifies identity first. A merely similar name is not refused —
        // it goes to review with the matches attached.
        const exact = duplicates.find((d) => d.is_active && isSameName(name, d.name));
        if (exact) {
            return res.status(409).json({
                error: `${exact.name} is already listed.`,
                claim_instead: { slug: exact.slug, name: exact.name },
                hint: 'Claim the existing listing instead — that route verifies you own it.',
            });
        }

        const slug = await uniqueSlug(name);

        const { data: authData, error: authError } = await db.auth.admin.createUser({
            email: loginEmailFor(phone),
            email_confirm: true,
            password: sessionSecret,
            user_metadata: {
                business_name: name,
                gcr_slug: slug,
                signup_source: 'business-phone',
                phone,                       // the real number, for the dashboard
                contact_email: email || null, // theirs, if they gave one
            },
        });
        if (authError) {
            const taken = /already|registered|exists/i.test(authError.message || '');
            return res.status(taken ? 409 : 400).json({
                error: taken ? 'There is already an account for that number.' : authError.message,
            });
        }
        authId = authData.user.id;

        // Does this business belong on GCR at all? Gulf Coast Radar covers a
        // 25-mile strip along the coast between New Orleans and Mexico Beach.
        // A business outside it is a CyberCheck customer with a dashboard, not
        // a directory listing — and never needs to be approved for one.
        //
        // With no usable location the answer is "unknown", and unknown is
        // treated as listed. The entity is inactive pending review either way,
        // so nothing is published on a guess.
        const city = (req.body?.city || '').trim() || null;
        const area = isInServiceArea({
            latitude: req.body?.latitude,
            longitude: req.body?.longitude,
            city,
        });
        const listedOnGcr = area.inArea !== false;

        // Inactive and hidden. Approval is what makes it public.
        const { data: entity, error: entityError } = await db
            .from('entity')
            .insert({
                slug,
                name,
                phone,
                email,
                website_url: (req.body?.website || '').trim() || null,
                city,
                entity_type: req.body?.entity_type || null,
                latitude: Number(req.body?.latitude) || null,
                longitude: Number(req.body?.longitude) || null,
                listed_on_gcr: listedOnGcr,
                is_active: false,
                show_in_listings: false,
            })
            .select('id, slug, name')
            .single();
        if (entityError) throw new Error(`Could not create the listing: ${entityError.message}`);
        entityId = entity.id;

        // Ownership, keyed by the Supabase Auth id — what the dashboard reads.
        const { error: ownerError } = await db.from('entity_owners').upsert(
            { user_id: authId, entity_id: entity.id, entity_slug: entity.slug, role: 'owner' },
            { onConflict: 'user_id,entity_id' }
        );
        if (ownerError) throw new Error(`Could not record ownership: ${ownerError.message}`);

        const { error: signupError } = await db.from('business_signups').insert({
            user_id: authId,
            phone,
            phone_verified_at: new Date().toISOString(),
            email,
            entity_slug: entity.slug,
            entity_id: entity.id,
            submitted_name: name,
            website: (req.body?.website || '').trim() || null,
            status: 'pending',
            possible_duplicates: duplicates,
            verification: {
                phone_verified: true,
                service_area: area.basis,          // coordinates | city | unknown
                miles_to_coast: area.miles,
                nearest_coast_town: area.nearest,
                in_service_area: area.inArea,      // true | false | null
            },
        });
        if (signupError) throw new Error(`Could not record the sign-up: ${signupError.message}`);

        // The finished session, so the browser needs no Supabase client of its
        // own. Minted here from the secret above, which then goes no further.
        // A failure to mint is not a failure to register — the account and the
        // listing exist either way, and the owner can sign in with their phone.
        let session = null;
        try {
            session = await mintSession(loginEmailFor(phone), sessionSecret);
        } catch (err) {
            console.error('[business-auth] session mint failed after register:', err.message);
        }

        res.status(201).json({
            slug: entity.slug,
            entity: { id: entity.id, slug: entity.slug, name: entity.name },
            session,
            // The address Supabase knows this account by, and a one-time
            // secret to sign in with right now. Neither is a credential the
            // business has, sees, or ever needs again — the phone is the login.
            //
            // Kept alongside `session` so a dashboard build that still redeems
            // them itself keeps working through the cutover. Once every client
            // reads `session`, these two fields come out.
            login_email: loginEmailFor(phone),
            session_secret: sessionSecret,
            phone,
            pending_review: true,
            possible_duplicates: duplicates.length,
            // Told plainly, because it changes what happens next: outside the
            // strip there is a dashboard but never a GCR listing.
            listed_on_gcr: listedOnGcr,
            service_area: {
                in_area: area.inArea,
                miles_to_coast: area.miles,
                nearest: area.nearest,
                limit_miles: SERVICE_AREA_MILES,
            },
            message: listedOnGcr
                ? 'Account created. Your listing stays hidden from the public site until it is reviewed.'
                : `Account created. Your dashboard is ready — Gulf Coast Radar only lists businesses within ${SERVICE_AREA_MILES} miles of the coast, so this one will not appear there.`,
        });
    } catch (err) {
        // Nothing half-created — an orphan auth account would lock that number
        // out of ever signing up again.
        if (entityId) await db.from('entity').delete().eq('id', entityId);
        if (authId) await db.auth.admin.deleteUser(authId);
        res.status(500).json({ error: err.message });
    }
});

/* ── signing in again ────────────────────────────────────────────────────
 *
 * Same two steps as signing up, and no password at either end. The number is
 * the login.
 */

// POST /signin — text a code to a number that already has an account.
router.post('/signin', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!looksLikePhone(phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });

    // Deliberately does NOT reveal whether the number has an account. Telling
    // a stranger which numbers are registered is a free directory of every
    // business owner on the platform. The code simply never arrives.
    try {
        await (await verifyService()).verifications.create({ to: phone, channel: 'sms' });
    } catch (err) {
        console.error('[business-auth] signin send failed:', err.message);
        return res.status(502).json({ error: 'Could not send the code — try again in a moment.' });
    }
    res.json({ success: true, phone });
});

// POST /signin-verify — check the code, hand back a one-time secret the
// browser signs in with.
router.post('/signin-verify', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!looksLikePhone(phone) || !code) return res.status(400).json({ error: 'Phone and code required.' });

    try {
        const check = await (await verifyService()).verificationChecks.create({ to: phone, code });
        if (check?.status !== 'approved') return res.status(400).json({ error: 'That code is not right.' });
    } catch {
        return res.status(400).json({ error: 'That code is not right, or it expired.' });
    }

    // The account behind the number, found in our own table. business_signups
    // already records user_id against the phone at registration, so this is a
    // direct indexed lookup rather than paging through every account on the
    // platform to find one email.
    const { data: signup, error: lookupError } = await db
        .from('business_signups')
        .select('user_id, entity_slug')
        .eq('phone', phone)
        .not('user_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (lookupError) return res.status(500).json({ error: lookupError.message });
    if (!signup) {
        return res.status(404).json({
            error: 'No business is set up on that number yet.',
            hint: 'Add your business first — it only takes the number you just verified.',
        });
    }
    const user = { id: signup.user_id };

    // Rotate. The previous secret dies here, so a leaked one is worthless
    // after the next sign-in.
    const sessionSecret = newSessionSecret();
    const { error: updateError } = await db.auth.admin.updateUserById(user.id, { password: sessionSecret });
    if (updateError) return res.status(500).json({ error: updateError.message });

    const { data: owned } = await db
        .from('entity_owners')
        .select('entity_slug')
        .eq('user_id', user.id)
        .limit(1);

    let session = null;
    try {
        session = await mintSession(loginEmailFor(phone), sessionSecret);
    } catch (err) {
        console.error('[business-auth] session mint failed after signin:', err.message);
        return res.status(502).json({ error: 'Could not start a session — try the code again.' });
    }

    res.json({
        success: true,
        phone,
        session,
        // The address Supabase knows this account by, and the secret that was
        // just spent on the session above. Kept only so a dashboard build that
        // still redeems them itself keeps working through the cutover.
        login_email: loginEmailFor(phone),
        session_secret: sessionSecret,
        entity_slug: owned?.[0]?.entity_slug || signup.entity_slug || null,
    });
});

/* ── sessions, for a browser with no Supabase client ─────────────────────
 *
 * Three small routes the dashboard needs once @supabase/supabase-js is gone
 * from its bundle: start a session from a password, keep it alive, end it.
 * None of them touches business data — they only turn a credential into a
 * token that middleware/ownerAuth.js can resolve.
 */

// POST /password — { identifier, password } → session.
//
// For the accounts that really do have a password: the invite flow, where the
// owner chose one. `identifier` is a slug or an email; a slug maps to the
// derived login address the invite was issued against.
router.post('/password', async (req, res) => {
    const identifier = String(req.body?.identifier || '').trim();
    const password = String(req.body?.password || '');
    if (!identifier || !password) return res.status(400).json({ error: 'Enter your details.' });

    const loginDomain = process.env.BUSINESS_LOGIN_DOMAIN || 'biz.gulfcoastradar.com';
    const email = identifier.includes('@')
        ? identifier.toLowerCase()
        : `${identifier.toLowerCase()}@${loginDomain}`;

    try {
        res.json({ success: true, session: await mintSession(email, password) });
    } catch (err) {
        // Deliberately the same answer for a wrong password and an account
        // that does not exist.
        res.status(err.status || 401).json({ error: 'That sign-in did not work.' });
    }
});

// POST /refresh — { refresh_token } → a fresh session.
//
// Supabase access tokens are short-lived. The browser used to renew them
// through the Supabase client; without one, it asks here instead.
router.post('/refresh', async (req, res) => {
    const refreshToken = String(req.body?.refresh_token || '').trim();
    if (!refreshToken) return res.status(400).json({ error: 'No refresh token.' });

    const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data?.session) return res.status(401).json({ error: 'That session has expired.' });

    res.json({ success: true, session: sessionPayload(data.session) });
});

// POST /signout — revoke the refresh token so it cannot be used again.
//
// Discarding the tokens in the browser is what ends the session for the user;
// this is what ends it for anyone who copied them. Answers 200 either way —
// a sign-out that reports failure gives a caller nothing it can act on.
router.post('/signout', async (req, res) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
        try {
            await authClient.auth.admin.signOut(header.slice(7));
        } catch (err) {
            console.error('[business-auth] signout failed:', err.message);
        }
    }
    res.json({ success: true });
});

/** A slug that is free, derived from the business name. */
async function uniqueSlug(name) {
    const base = String(name)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'business';

    const { data } = await db.from('entity').select('slug').or(`slug.eq.${base},slug.like.${base}-%`);
    const taken = new Set((data || []).map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 500; n += 1) {
        if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
    return `${base}-${Date.now().toString(36)}`;
}

module.exports = router;
