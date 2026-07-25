/**
 * Trip-swipe tourist sign-up with 6-digit email code verification via Brevo.
 *
 *   POST /api/tourist-auth/signup          { email, password } → sends 6-digit code by email
 *   POST /api/tourist-auth/verify          { email, code }     → marks confirmed, returns JSON
 *   POST /api/tourist-auth/resend          { email }           → re-send code by email
 *   POST /api/tourist-auth/signin          { email, password } → Supabase session
 *   POST /api/tourist-auth/forgot-password { email }           → reset link by email
 *   POST /api/tourist-auth/reset-password  { email, token, password }
 */

const express = require('express');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendEmail } = require('../utils/email');

// Firebase Admin — verifies Firebase phone auth tokens
let _firebaseAdmin = null;
function getFirebaseAdmin() {
  if (_firebaseAdmin) return _firebaseAdmin;
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const projectId   = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey  = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error('Firebase Admin not configured: set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
    }
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  }
  _firebaseAdmin = admin;
  return admin;
}
const mainDb = require('../db');

const router = express.Router();

// Cached admin client — avoids creating a new instance per request
let _adminClient = null;
function admin() {
    if (!_adminClient) _adminClient = createClient(
      process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL,
      process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY
    );
    return _adminClient;
}

function makeCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

// Verify a tourist's Bearer token → attach req.touristId / req.touristEmail
async function touristAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    const token = header.split(' ')[1];
    try {
        const { data, error } = await mainDb.auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' });
        req.touristId = data.user.id;
        req.touristEmail = data.user.email;
        return next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// Backfill: Link all pre-signup activity to the new user (fire-and-forget)
//
// visitorId doubles as the Trip Swipe guest id: touristAuthOptional (in
// tourist.js) lets a signed-out visitor write tourist_swipe_events/
// tourist_seen/tourist_saves/user_preference_scores keyed directly by this
// same UUID (none of those tables have a foreign key to auth.users, so
// that's a safe write). Once they actually sign up, everything they did as
// a guest — every swipe, every save — needs to end up under their real
// account instead of orphaned under a UUID nobody will ever see again.
// ─────────────────────────────────────────────────────────────────────────────
const { _recomputeAllPreferences } = require('./tourist');

async function backfillAnonymousActivity(userId, visitorId) {
    try {
        // gcr_page_views/session_events/qr_scans backfill intentionally omitted:
        // none of those tables carry the user_id/visitor_id columns this used to
        // assume (gcr_page_views keys on entity_id, qr_scans on entity_slug/
        // qr_code_id, session_events doesn't exist) — confirmed by a separate,
        // dedicated data-structure assessment. Re-add only once a real identity
        // column exists on one of those tables.
        await Promise.all([
            // Neither table has a unique constraint that a guest UUID's rows
            // could collide with on the real account, so a plain reassign is safe.
            mainDb.from('tourist_swipe_events')
                .update({ tourist_id: userId })
                .eq('tourist_id', visitorId),
            mainDb.from('tourist_seen')
                .update({ tourist_id: userId })
                .eq('tourist_id', visitorId),
        ]);

        // tourist_saves has a (user_id, entity_slug) unique constraint, so a
        // bulk reassign could collide if the real account already saved the
        // same place from another device — upsert each row individually
        // instead of one bulk UPDATE (which Postgres would abort entirely on
        // the first conflict).
        const { data: guestSaves } = await mainDb.from('tourist_saves').select('*').eq('user_id', visitorId);
        for (const s of (guestSaves || [])) {
            const { id, user_id, ...rest } = s;
            await mainDb.from('tourist_saves')
                .upsert({ ...rest, user_id: userId }, { onConflict: 'user_id,entity_slug' })
                .catch(err => console.warn('[Backfill] save upsert failed:', err.message));
        }
        if (guestSaves?.length) {
            await mainDb.from('tourist_saves').delete().eq('user_id', visitorId).catch(() => {});
        }

        // Preference scores aren't safe to merge row-by-row (the guest and
        // the real account could each have a score for the same tag — adding
        // them risks double-counting). Now that the swipes/saves live under
        // the real user id, wipe any stray guest-keyed scores and rebuild
        // clean from the now-unified history instead of trying to combine
        // two conflicting sets of numbers.
        await mainDb.from('user_preference_scores').delete().eq('user_id', visitorId).catch(() => {});
        await _recomputeAllPreferences(userId).catch(err =>
            console.warn('[Backfill] preference recompute failed:', err.message));

        console.log('[Backfill] Linked anonymous activity for', userId, 'from visitor', visitorId);
    } catch (err) {
        console.error('[Backfill error]', err.message);
    }
}

// Lookup user by email — supabase-js's admin API has no getUserByEmail method
// (only createUser/listUsers/getUserById exist), so page through listUsers and
// match client-side instead.
async function getUserByEmail(email) {
    const sb = admin();
    const target = (email || '').trim().toLowerCase();
    if (!target) return null;
    try {
        for (let page = 1; page <= 20; page++) {
            const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
            if (error || !data?.users?.length) return null;
            const match = data.users.find(u => (u.email || '').toLowerCase() === target);
            if (match) return match;
            if (data.users.length < 1000) return null; // last page
        }
        return null;
    } catch { return null; }
}

function codeEmailHtml({ code }) {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;"><tr><td align="center">
    <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
      <tr><td style="background:linear-gradient(135deg,#0ea5e9,#7c6af7);padding:40px 32px 32px;text-align:center;">
        <h1 style="margin:0;color:#fff;font-size:26px;">🌊 Gulf Coast Radar</h1>
        <p style="margin:10px 0 0;color:#e0f2fe;font-size:15px;">Your verification code</p>
      </td></tr>
      <tr><td style="padding:40px 32px;text-align:center;">
        <p style="margin:0 0 24px;color:#374151;font-size:15px;">Enter this code on the site to confirm your account:</p>
        <div style="display:inline-block;background:#f0f9ff;border:2px solid #0ea5e9;border-radius:14px;padding:20px 36px;margin-bottom:28px;">
          <span style="font-size:48px;font-weight:800;letter-spacing:14px;color:#0c4a6e;font-family:monospace;">${code}</span>
        </div>
        <p style="margin:0;color:#6b7280;font-size:13px;">This code expires in 24 hours. If you didn't sign up, ignore this email.</p>
      </td></tr>
      <tr><td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
        <p style="margin:0;color:#9ca3af;font-size:12px;">Gulf Coast Radar — Swipe your way to the perfect Gulf Coast trip</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /signup
// ─────────────────────────────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const sb = admin();
    const code = makeCode();
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const existing = await getUserByEmail(email);

    if (existing) {
        if (existing.email_confirmed_at) return res.status(409).json({ error: 'Email already registered. Try signing in instead.' });
        await sb.auth.admin.updateUserById(existing.id, {
            password,
            user_metadata: { ...(existing.user_metadata || {}), verification_code: code, verification_expires_at: expiresAt },
        });
    } else {
        const { error } = await sb.auth.admin.createUser({
            email, password,
            email_confirm: false,
            user_metadata: { verification_code: code, verification_expires_at: expiresAt },
        });
        if (error) return res.status(500).json({ error: error.message });
    }

    const send = await sendEmail({ to: email, subject: '🌊 Your Gulf Coast Radar verification code', html: codeEmailHtml({ code }) });
    if (!send.success) return res.status(500).json({ error: 'Failed to send verification email: ' + (send.error || send.reason || send.message || 'unknown') });

    res.json({ success: true, message: 'Verification code sent — check your inbox.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /verify — { email, code } → JSON response (no redirect)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify', async (req, res) => {
    const code  = (req.body?.code  || '').trim();
    const email = (req.body?.email || '').trim().toLowerCase();
    const first_app = req.body?.first_app || 'unknown'; // 'gcr', 'trip_swipe', or 'unknown'
    const anonymous_visitor_id = req.body?.anonymous_visitor_id || null;

    if (!code || !email) return res.status(400).json({ error: 'Email and code required' });

    const sb = admin();
    const user = await getUserByEmail(email);
    if (!user) return res.status(400).json({ error: 'No account found for that email' });

    if (user.email_confirmed_at) return res.json({ success: true });

    const stored = user.user_metadata || {};
    if (stored.verification_code !== code) return res.status(400).json({ error: 'Incorrect code — check and try again' });
    if (stored.verification_expires_at && new Date(stored.verification_expires_at) < new Date()) {
        return res.status(400).json({ error: 'Code expired — tap Resend for a new one' });
    }

    const { error } = await sb.auth.admin.updateUserById(user.id, {
        email_confirm: true,
        user_metadata: { ...stored, verification_code: null, verification_expires_at: null, verified_at: new Date().toISOString() },
    });
    if (error) return res.status(500).json({ error: error.message });

    // Seed a minimal profile row with first_app + anonymous_visitor_id
    await mainDb.from('tourist_profiles')
        .upsert({
            user_id: user.id,
            setup_complete: false,
            first_app: first_app,
            anonymous_visitor_id: anonymous_visitor_id
        }, { onConflict: 'user_id', ignoreDuplicates: true });

    // Fire-and-forget backfill: link all pre-signup activity to this user
    if (anonymous_visitor_id) {
        backfillAnonymousActivity(user.id, anonymous_visitor_id).catch(err => {
            console.warn('Backfill failed for', user.id, ':', err.message);
        });
    }

    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /signin
// ─────────────────────────────────────────────────────────────────────────────
router.post('/signin', async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    try {
        const { data: d, error } = await admin().auth.signInWithPassword({ email, password });
        if (error) {
            const text = (error.message || '').toString();
            const msg = /confirm/i.test(text)
                ? 'Please confirm your email before signing in — check your inbox.'
                : 'Invalid email or password';
            return res.status(401).json({ error: msg });
        }
        // A returning user can still have picked up new guest activity this
        // session (e.g. browsed a few cards before tapping sign in) — merge
        // it into their existing account the same as a fresh signup would.
        const anonymous_visitor_id = req.body?.anonymous_visitor_id || null;
        if (anonymous_visitor_id && d.user?.id) {
            backfillAnonymousActivity(d.user.id, anonymous_visitor_id).catch(err => {
                console.warn('Backfill failed for', d.user.id, ':', err.message);
            });
        }

        res.json({
            session: {
                access_token: d.session?.access_token,
                refresh_token: d.session?.refresh_token,
                expires_at: d.session?.expires_at,
            },
            user: { id: d.user?.id, email: d.user?.email, role: 'tourist' },
        });
    } catch (err) {
        res.status(500).json({ error: 'Signin failed: ' + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /resend
// ─────────────────────────────────────────────────────────────────────────────
router.post('/resend', async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

    const sb = admin();
    const user = await getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'No account with that email' });
    if (user.email_confirmed_at) return res.json({ success: true, message: 'Already confirmed — try signing in.' });

    const code = makeCode();
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await sb.auth.admin.updateUserById(user.id, {
        user_metadata: { ...(user.user_metadata || {}), verification_code: code, verification_expires_at: expiresAt },
    });

    const send = await sendEmail({ to: email, subject: '🌊 Your new Gulf Coast Radar verification code', html: codeEmailHtml({ code }) });
    if (!send.success) return res.status(500).json({ error: 'Failed to send email' });

    res.json({ success: true, message: 'New code sent — check your inbox.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /forgot-password
// ─────────────────────────────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

    const sb = admin();
    const user = await getUserByEmail(email);
    if (!user) return res.json({ success: true, message: 'If that email is registered, a reset link was sent.' });

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1 * 3600 * 1000).toISOString();
    await sb.auth.admin.updateUserById(user.id, {
        user_metadata: { ...(user.user_metadata || {}), reset_token: token, reset_expires_at: expiresAt },
    });

    const appUrl = process.env.TRIP_SWIPE_URL || 'https://trip-swipe.vercel.app';
    const resetHref = `${appUrl}/reset?token=${token}&email=${encodeURIComponent(email)}`;
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;"><tr><td align="center">
    <table width="100%" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;">
      <tr><td style="background:linear-gradient(135deg,#0ea5e9,#7c6af7);padding:36px 32px;text-align:center;">
        <h1 style="margin:0;color:#fff;font-size:24px;">🌊 Reset your password</h1>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="margin:0 0 20px;color:#374151;font-size:15px;">Click the link below to set a new password. This link expires in 1 hour.</p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${resetHref}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;">Reset Password →</a>
        </div>
        <p style="margin:20px 0 0;color:#6b7280;font-size:13px;">If you didn't request this, ignore the email.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
    await sendEmail({ to: email, subject: 'Reset your Gulf Coast Radar password', html });
    res.json({ success: true, message: 'If that email is registered, a reset link was sent.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /reset-password
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const token = req.body?.token || '';
    const password = req.body?.password || '';
    if (!email || !token) return res.status(400).json({ error: 'Invalid reset link' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const sb = admin();
    const user = await getUserByEmail(email);
    if (!user) return res.status(400).json({ error: 'Invalid reset link' });

    const md = user.user_metadata || {};
    if (md.reset_token !== token) return res.status(400).json({ error: 'Invalid reset link' });
    if (md.reset_expires_at && new Date(md.reset_expires_at) < new Date()) return res.status(400).json({ error: 'Reset link expired' });

    const { error } = await sb.auth.admin.updateUserById(user.id, {
        password,
        email_confirm: true,
        user_metadata: { ...md, reset_token: null, reset_expires_at: null, verified_at: md.verified_at || new Date().toISOString() },
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// TWILIO VERIFY — PHONE OTP
// POST /api/tourist-auth/phone        { phone }        → sends 6-digit OTP via Twilio Verify
// POST /api/tourist-auth/phone-verify { phone, code }  → checks OTP via Twilio Verify → upsert tourist_profile → return token
//
// Uses Twilio Verify (not Programmable Messaging) — Verify runs through Twilio's
// own verified sending infrastructure instead of our long-code number, so it
// isn't subject to A2P 10DLC campaign registration the way our other SMS
// (routes/sms.js, live-photo.js, dashboard.js, etc.) is. Requires a Verify
// Service created in the Twilio Console and its SID set as
// TWILIO_VERIFY_SERVICE_SID.
// ─────────────────────────────────────────────────────────────────────────────

const twilio = require('twilio');

function verifyService() {
    if (!process.env.TWILIO_VERIFY_SERVICE_SID) throw new Error('TWILIO_VERIFY_SERVICE_SID not configured');
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
        .verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID);
}

function normalizePhone(raw) {
    const digits = (raw || '').replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
    return `+${digits}`;
}

// POST /phone — send OTP via Twilio Verify
router.post('/phone', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone || phone.length < 10) return res.status(400).json({ error: 'Valid phone number required' });

    try {
        await verifyService().verifications.create({ to: phone, channel: 'sms' });
    } catch (e) {
        console.error('Twilio Verify send failed:', e.message);
        // TEMPORARY: surfacing e.message to the client to diagnose the live
        // failure without log access. Revert to the generic message once
        // resolved -- don't leave raw provider errors exposed long-term.
        return res.status(500).json({ error: 'Failed to send code: ' + e.message });
    }

    res.json({ success: true, phone });
});

// POST /phone-verify — verify OTP → create/find auth user → return session
router.post('/phone-verify', async (req, res) => {
    const phone   = normalizePhone(req.body?.phone);
    const idToken = (req.body?.idToken || '').trim();
    const code    = (req.body?.code || '').trim(); // legacy fallback

    if (!phone) return res.status(400).json({ error: 'Phone required' });

    if (idToken) {
        // Firebase path — verify the ID token server-side
        try {
            const admin = getFirebaseAdmin();
            const decoded = await admin.auth().verifyIdToken(idToken);
            // Confirm the token's phone matches what was submitted
            if (decoded.phone_number && normalizePhone(decoded.phone_number) !== phone) {
                return res.status(400).json({ error: 'Phone number mismatch' });
            }
        } catch (err) {
            return res.status(401).json({ error: 'Invalid Firebase token: ' + err.message });
        }
    } else if (code) {
        // Twilio Verify path
        let check;
        try {
            check = await verifyService().verificationChecks.create({ to: phone, code });
        } catch (e) {
            console.error('Twilio Verify check failed:', e.message);
            return res.status(400).json({ error: 'Incorrect or expired code' });
        }
        if (check.status !== 'approved') return res.status(400).json({ error: 'Incorrect code' });
    } else {
        return res.status(400).json({ error: 'idToken or code required' });
    }

    const result = await establishPhoneSession(phone, req.body?.anonymous_visitor_id || null);
    if (result.error) return res.status(result.status || 500).json({ error: result.error });
    res.json(result.body);
});

// Shared: given a proven phone, find/create the auth user, link the profile,
// clear any pending OTP/token, sign in, and return the session response body.
// Used by both /phone-verify (code path) and /phone-token (magic-link path).
// Phone signup is the main path Trip Swipe users actually take (the SMS
// opt-in flow), so this needs the same anonymous_visitor_id handling the
// email path already had — without it, phone signups would never get their
// guest-era swipes/saves merged in.
async function establishPhoneSession(phone, anonymous_visitor_id) {
    const sb = admin();
    const fakeEmail = `${phone.replace(/\+/, '')}@gcr.tourist`;
    // stable password derived from phone — same every time so sign-in always works
    const stablePassword = require('crypto').createHash('sha256').update(phone + 'gcr-salt').digest('hex');

    // Find or create Supabase auth user
    let authUser = await getUserByEmail(fakeEmail);
    const isNewUser = !authUser;

    if (!authUser) {
        const { data: created, error: createErr } = await sb.auth.admin.createUser({
            email: fakeEmail,
            password: stablePassword,
            email_confirm: true,
            user_metadata: { phone },
        });
        if (createErr) return { error: 'Could not create account: ' + createErr.message };
        authUser = created?.user || null;
    }

    if (!authUser) return { error: 'Could not create account' };

    // Upsert tourist_profiles keyed by user_id, linking phone. Only stamp
    // anonymous_visitor_id on first creation — a returning user re-verifying
    // shouldn't have their original guest id overwritten by whatever guest id
    // happens to be sitting in this browser's localStorage right now.
    const profileRow = {
        user_id:     authUser.id,
        phone,
        otp_code:    null,
        otp_expires: null,
        sms_opt_in:  true,
        last_active: new Date().toISOString(),
        updated_at:  new Date().toISOString(),
    };
    if (isNewUser && anonymous_visitor_id) profileRow.anonymous_visitor_id = anonymous_visitor_id;

    const { data: profile, error: upsertErr } = await mainDb
        .from('tourist_profiles')
        .upsert(profileRow, { onConflict: 'user_id' })
        .select('user_id, phone, name, setup_complete')
        .single();

    if (upsertErr) {
        console.error('tourist_profiles upsert error:', upsertErr.message);
        return { error: 'Could not save profile' };
    }

    // Fire-and-forget: link all pre-signup guest activity to this user
    if (anonymous_visitor_id) {
        backfillAnonymousActivity(authUser.id, anonymous_visitor_id).catch(err => {
            console.warn('Backfill failed for', authUser.id, ':', err.message);
        });
    }

    // Clear OTP/token from tourist_otps now that it's been used
    await mainDb.from('tourist_otps')
        .update({ otp_code: null, otp_expires: null })
        .eq('phone', phone)
        .catch(() => {});

    // Sign in to get a real access token
    const { data: signIn, error: signInErr } = await sb.auth.signInWithPassword({
        email: fakeEmail,
        password: stablePassword,
    });
    if (signInErr) return { error: 'Sign in failed: ' + signInErr.message };

    const sess = signIn?.session || null;

    return {
        body: {
            success:      true,
            tourist:      profile,
            // Legacy field (existing clients)
            access_token: sess?.access_token || null,
            // Full session + user (matches /signin response shape so clients can share hydration code)
            session: sess ? {
                access_token:  sess.access_token,
                refresh_token: sess.refresh_token,
                expires_at:    sess.expires_at,
            } : null,
            user: {
                id:    authUser.id,
                email: authUser.email,
                phone,
                role:  'tourist',
            },
        },
    };
}

// POST /phone-token — tap-to-sign-in via magic link. Verifies a one-time token
// (texted to the tourist by the SMS webhook), resolves the phone, signs in.
// No 6-digit code to type — the token in the link IS the proof.
router.post('/phone-token', async (req, res) => {
    const token = (req.body?.token || '').trim();
    if (!token || token.length < 20) return res.status(400).json({ error: 'Invalid sign-in link' });

    const { data: row } = await mainDb
        .from('tourist_otps')
        .select('phone, otp_code, otp_expires')
        .eq('otp_code', token)
        .maybeSingle();

    if (!row?.phone) return res.status(400).json({ error: 'This sign-in link is invalid or already used. Text us again for a new one.' });
    if (new Date(row.otp_expires) < new Date()) return res.status(400).json({ error: 'This sign-in link expired. Text us again for a new one.' });

    const result = await establishPhoneSession(row.phone, req.body?.anonymous_visitor_id || null);
    if (result.error) return res.status(result.status || 500).json({ error: result.error });
    res.json(result.body);
});

// ─────────────────────────────────────────────────────────────────────────────
// ADD EMAIL TO EXISTING (PHONE-SIGNUP) ACCOUNT
// Lets a user who signed up via SMS attach a real email + password so they can
// also log in by email. Same auth.users row — single account, two methods.
//
// POST /add-email         { email, password } (auth)  → sends 6-digit code to email
// POST /verify-add-email  { code, password }  (auth)  → updates auth user
// ─────────────────────────────────────────────────────────────────────────────

router.post('/add-email', touristAuth, async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Refuse if the account already has a real (non-placeholder) email
    if (req.touristEmail && !req.touristEmail.endsWith('@gcr.tourist')) {
        return res.status(409).json({ error: 'Account already has an email. Sign out and use Forgot Password to change it.' });
    }

    // Refuse if that email belongs to a different account
    const existing = await getUserByEmail(email);
    if (existing && existing.id !== req.touristId) {
        return res.status(409).json({ error: 'That email is already in use.' });
    }

    const sb = admin();
    const code = makeCode();
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const { data: userData, error: getErr } = await sb.auth.admin.getUserById(req.touristId);
    if (getErr || !userData?.user) return res.status(500).json({ error: 'Could not load account' });
    const md = userData.user.user_metadata || {};

    const { error: updErr } = await sb.auth.admin.updateUserById(req.touristId, {
        user_metadata: {
            ...md,
            pending_email: email,
            email_verification_code: code,
            email_verification_expires_at: expiresAt,
        },
    });
    if (updErr) return res.status(500).json({ error: 'Could not save code: ' + updErr.message });

    const send = await sendEmail({ to: email, subject: '🌊 Your Gulf Coast Radar verification code', html: codeEmailHtml({ code }) });
    if (!send.success) return res.status(500).json({ error: 'Failed to send verification email' });

    res.json({ success: true, message: 'Verification code sent — check your inbox.' });
});

router.post('/verify-add-email', touristAuth, async (req, res) => {
    const code = (req.body?.code || '').trim();
    const password = req.body?.password || '';

    if (!code) return res.status(400).json({ error: 'Code required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const sb = admin();
    const { data: userData, error: getErr } = await sb.auth.admin.getUserById(req.touristId);
    if (getErr || !userData?.user) return res.status(500).json({ error: 'Could not load account' });
    const md = userData.user.user_metadata || {};

    if (!md.pending_email) return res.status(400).json({ error: 'No pending email — request one first.' });
    if (md.email_verification_code !== code) return res.status(400).json({ error: 'Incorrect code' });
    if (md.email_verification_expires_at && new Date(md.email_verification_expires_at) < new Date()) {
        return res.status(400).json({ error: 'Code expired — request a new one.' });
    }

    // Final ownership check (could have been claimed since the code was sent)
    const claimed = await getUserByEmail(md.pending_email);
    if (claimed && claimed.id !== req.touristId) {
        return res.status(409).json({ error: 'That email is already in use.' });
    }

    const { error } = await sb.auth.admin.updateUserById(req.touristId, {
        email: md.pending_email,
        password,
        email_confirm: true,
        user_metadata: {
            ...md,
            pending_email: null,
            email_verification_code: null,
            email_verification_expires_at: null,
            verified_at: md.verified_at || new Date().toISOString(),
        },
    });
    if (error) return res.status(500).json({ error: 'Could not update email: ' + error.message });

    res.json({ success: true, email: md.pending_email });
});

module.exports = router;
