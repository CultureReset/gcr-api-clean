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

// Lookup user by email using admin API (scales to any number of users)
async function getUserByEmail(email) {
    const sb = admin();
    // Supabase admin v2: filter by email directly
    const { data, error } = await sb.auth.admin.listUsers({ perPage: 1, page: 1, filter: `email.eq.${email}` });
    if (error || !data?.users?.length) {
        // fallback: try fetching via service role getUserByEmail if available
        try {
            const { data: d2 } = await sb.auth.admin.getUserByEmail(email);
            return d2?.user || null;
        } catch { return null; }
    }
    return data.users[0] || null;
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

    const send = await sendEmail({
        to: email,
        subject: '🌊 Your Gulf Coast Radar verification code',
        html: codeEmailHtml({ code }),
    });
    if (!send.success) return res.status(500).json({ error: 'Failed to send verification email: ' + (send.reason || 'unknown') });

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

    const send = await sendEmail({
        to: email,
        subject: '🌊 Your new Gulf Coast Radar verification code',
        html: codeEmailHtml({ code }),
    });
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
// SENDBLUE PHONE OTP — new tourist login via iMessage
// POST /api/tourist-auth/phone        { phone }        → sends 6-digit OTP via Sendblue
// POST /api/tourist-auth/phone-verify { phone, code }  → verify OTP → upsert tourist_profile → return token
// ─────────────────────────────────────────────────────────────────────────────

async function getSendblueConfig() {
    try {
        const { data } = await mainDb.from('platform_settings').select('value').eq('key', 'sms_config').maybeSingle();
        if (data?.value?.sendblue_key_id) return data.value;
    } catch {}
    return {
        sendblue_key_id: process.env.SENDBLUE_KEY_ID,
        sendblue_secret:  process.env.SENDBLUE_SECRET,
    };
}

async function sendblueMessage(phone, content) {
    const cfg = await getSendblueConfig();
    if (!cfg.sendblue_key_id || !cfg.sendblue_secret) throw new Error('Sendblue not configured');
    const res = await fetch('https://api.sendblue.co/api/send-message', {
        method: 'POST',
        headers: {
            'sb-api-key-id':     cfg.sendblue_key_id,
            'sb-api-secret-key': cfg.sendblue_secret,
            'Content-Type':      'application/json',
        },
        body: JSON.stringify({ number: phone, content }),
    });
    if (!res.ok) throw new Error(`Sendblue error: ${res.status}`);
    return res.json();
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

    // Store OTP — upsert tourist_profiles row keyed by phone
    const { error: dbErr } = await mainDb
        .from('tourist_profiles')
        .upsert({ phone, otp_code: code, otp_expires: expires, updated_at: new Date().toISOString() }, { onConflict: 'phone' });

    if (dbErr) {
        // Table may not exist yet in old DB — store in tourist_sessions fallback
        await mainDb.from('tourist_sessions').upsert(
            { phone, otp_code: code, otp_expires: expires },
            { onConflict: 'phone' }
        ).catch(() => {});
    }

    try {
        await sendblueMessage(phone, `Your Gulf Coast Radar code is ${code}\n\nExpires in 10 minutes.`);
    } catch (e) {
        console.error('Sendblue OTP send failed:', e.message);
        return res.status(500).json({ error: 'Failed to send code. Check Sendblue config.' });
    }

    res.json({ success: true, phone });
});

// POST /phone-verify — verify OTP → create session
router.post('/phone-verify', async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const code  = (req.body?.code || '').trim();
    if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

    // Check tourist_profiles first, fallback to tourist_sessions
    let storedCode = null, storedExpires = null, profileId = null;

    const { data: profile } = await mainDb
        .from('tourist_profiles')
        .select('id, otp_code, otp_expires')
        .eq('phone', phone)
        .maybeSingle();

    if (profile) {
        storedCode    = profile.otp_code;
        storedExpires = profile.otp_expires;
        profileId     = profile.id;
    } else {
        const { data: session } = await mainDb
            .from('tourist_sessions')
            .select('id, otp_code, otp_expires')
            .eq('phone', phone)
            .maybeSingle();
        if (session) { storedCode = session.otp_code; storedExpires = session.otp_expires; }
    }

    if (!storedCode) return res.status(400).json({ error: 'No code found. Request a new one.' });
    if (storedCode !== code) return res.status(400).json({ error: 'Incorrect code' });
    if (new Date(storedExpires) < new Date()) return res.status(400).json({ error: 'Code expired. Request a new one.' });

    // Mark verified — upsert tourist_profiles with phone confirmed
    const { data: upserted, error: upsertErr } = await mainDb
        .from('tourist_profiles')
        .upsert({
            phone,
            otp_code:       null,
            otp_expires:    null,
            sms_opt_in:     true,
            sms_opted_in_at: profileId ? undefined : new Date().toISOString(),
            last_active:    new Date().toISOString(),
            updated_at:     new Date().toISOString(),
        }, { onConflict: 'phone' })
        .select('id, phone, name, setup_complete')
        .single();

    if (upsertErr) {
        console.error('tourist_profiles upsert error:', upsertErr.message);
        return res.status(500).json({ error: 'Could not create profile' });
    }

    // Sign a Supabase anon session for this user using service role
    // so the tourist JWT works with existing touristAuth middleware
    const sb = admin();
    let accessToken = null;
    try {
        // Create/find Supabase auth user keyed by phone as email alias
        const fakeEmail = `${phone.replace(/\+/, '')}@gcr.tourist`;
        let authUser = null;
        try {
            const { data: existing } = await sb.auth.admin.getUserByEmail(fakeEmail);
            authUser = existing?.user || null;
        } catch {}

        if (!authUser) {
            const { data: created } = await sb.auth.admin.createUser({
                email: fakeEmail,
                password: upserted.id, // stable per-user secret
                email_confirm: true,
                user_metadata: { phone, tourist_profile_id: upserted.id },
            });
            authUser = created?.user || null;
        }

        if (authUser) {
            const { data: session } = await sb.auth.admin.generateLink({
                type: 'magiclink',
                email: fakeEmail,
            });
            // Use service-role signIn to get a real access token
            const { data: signIn } = await sb.auth.signInWithPassword({
                email: fakeEmail,
                password: upserted.id,
            });
            accessToken = signIn?.session?.access_token || null;
        }
    } catch (e) {
        console.error('Auth token generation error:', e.message);
    }

    res.json({
        success:      true,
        tourist:      upserted,
        access_token: accessToken,
    });
});

module.exports = router;
