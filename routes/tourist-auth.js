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
    admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'gcr-admin' });
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
// ─────────────────────────────────────────────────────────────────────────────
async function backfillAnonymousActivity(userId, visitorId) {
    try {
        // Update all tables where visitor_id matches with the new user_id
        await Promise.all([
            mainDb.from('gcr_page_views')
                .update({ user_id: userId })
                .eq('visitor_id', visitorId)
                .is('user_id', null),
            mainDb.from('session_events')
                .update({ user_id: userId })
                .eq('visitor_id', visitorId)
                .is('user_id', null),
            mainDb.from('qr_scans')
                .update({ user_id: userId })
                .eq('visitor_id', visitorId)
                .is('user_id', null),
        ]);
        console.log('[Backfill] Linked anonymous activity for', userId, 'from visitor', visitorId);
    } catch (err) {
        console.error('[Backfill error]', err.message);
    }
}

// Lookup user by email using admin API
async function getUserByEmail(email) {
    const sb = admin();
    try {
        const { data, error } = await sb.auth.admin.getUserByEmail(email);
        if (error || !data?.user) return null;
        return data.user;
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

    const send = await sendEmail(email, '🌊 Your Gulf Coast Radar verification code', codeEmailHtml({ code }));
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

    const send = await sendEmail(email, '🌊 Your new Gulf Coast Radar verification code', codeEmailHtml({ code }));
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
    await sendEmail(email, 'Reset your Gulf Coast Radar password', html);
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
// TWILIO PHONE OTP
// POST /api/tourist-auth/phone        { phone }        → sends 6-digit OTP via Twilio SMS
// POST /api/tourist-auth/phone-verify { phone, code }  → verify OTP → upsert tourist_profile → return token
// ─────────────────────────────────────────────────────────────────────────────

const twilio = require('twilio');

async function sendTwilioSMS(phone, body) {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    return client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER || '+12513135464',
        to:   phone,
        body,
    });
}

function normalizePhone(raw) {
    const digits = (raw || '').replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
    return `+${digits}`;
}

// POST /phone — send OTP
router.post('/phone', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone || phone.length < 10) return res.status(400).json({ error: 'Valid phone number required' });

    const code    = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    // Store OTP in tourist_otps (no user_id required — user may not exist yet)
    const { error: dbErr } = await mainDb
        .from('tourist_otps')
        .upsert({ phone, otp_code: code, otp_expires: expires, updated_at: new Date().toISOString() }, { onConflict: 'phone' });

    if (dbErr) {
        console.error('OTP storage error:', dbErr.message);
        return res.status(500).json({ error: 'Could not generate code. Try again.' });
    }

    try {
        await sendTwilioSMS(phone, `Your Gulf Coast Radar code is ${code}\n\nExpires in 10 minutes.`);
    } catch (e) {
        console.error('Twilio OTP send failed:', e.message);
        return res.status(500).json({ error: 'Failed to send code. Check Twilio config.' });
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
        // Legacy OTP path (Twilio/Supabase)
        const { data: otpRow } = await mainDb
            .from('tourist_otps')
            .select('otp_code, otp_expires')
            .eq('phone', phone)
            .maybeSingle();

        if (!otpRow?.otp_code) return res.status(400).json({ error: 'No code found. Request a new one.' });
        if (otpRow.otp_code !== code) return res.status(400).json({ error: 'Incorrect code' });
        if (new Date(otpRow.otp_expires) < new Date()) return res.status(400).json({ error: 'Code expired. Request a new one.' });
    } else {
        return res.status(400).json({ error: 'idToken or code required' });
    }

    const sb = admin();
    const fakeEmail = `${phone.replace(/\+/, '')}@gcr.tourist`;
    // stable password derived from phone — same every time so sign-in always works
    const stablePassword = require('crypto').createHash('sha256').update(phone + 'gcr-salt').digest('hex');

    // Find or create Supabase auth user
    let authUser = null;
    try {
        const { data: existing } = await sb.auth.admin.getUserByEmail(fakeEmail);
        authUser = existing?.user || null;
    } catch {}

    if (!authUser) {
        const { data: created, error: createErr } = await sb.auth.admin.createUser({
            email: fakeEmail,
            password: stablePassword,
            email_confirm: true,
            user_metadata: { phone },
        });
        if (createErr) return res.status(500).json({ error: 'Could not create account: ' + createErr.message });
        authUser = created?.user || null;
    }

    if (!authUser) return res.status(500).json({ error: 'Could not create account' });

    // Upsert tourist_profiles keyed by user_id, linking phone
    const { data: profile, error: upsertErr } = await mainDb
        .from('tourist_profiles')
        .upsert({
            user_id:     authUser.id,
            phone,
            otp_code:    null,
            otp_expires: null,
            sms_opt_in:  true,
            last_active: new Date().toISOString(),
            updated_at:  new Date().toISOString(),
        }, { onConflict: 'user_id' })
        .select('user_id, phone, name, setup_complete')
        .single();

    if (upsertErr) {
        console.error('tourist_profiles upsert error:', upsertErr.message);
        return res.status(500).json({ error: 'Could not save profile' });
    }

    // Clear OTP from tourist_otps now that it's been used
    await mainDb.from('tourist_otps')
        .update({ otp_code: null, otp_expires: null })
        .eq('phone', phone)
        .catch(() => {});

    // Sign in to get a real access token
    const { data: signIn, error: signInErr } = await sb.auth.signInWithPassword({
        email: fakeEmail,
        password: stablePassword,
    });
    if (signInErr) return res.status(500).json({ error: 'Sign in failed: ' + signInErr.message });

    const sess = signIn?.session || null;

    res.json({
        success:       true,
        tourist:       profile,
        // Legacy fields (existing clients)
        access_token:  sess?.access_token || null,
        // Full session + user (matches /signin response shape so clients can share hydration code)
        session: sess ? {
            access_token:  sess.access_token,
            refresh_token: sess.refresh_token,
            expires_at:    sess.expires_at,
        } : null,
        user: authUser ? {
            id:    authUser.id,
            email: authUser.email,
            phone,
            role:  'tourist',
        } : null,
    });
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

    const send = await sendEmail(email, '🌊 Your Gulf Coast Radar verification code', codeEmailHtml({ code }));
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
