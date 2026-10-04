// ============================================================
// PHONE VERIFICATION — our own codes, sent through lib/telephony
// ============================================================
//
// What Twilio Verify used to do for tourist sign-in, done here so it works on
// whichever carrier is live (Telnyx by default). A code is a random number of
// VERIFY_CODE_DIGITS digits, texted from the platform sender, stored only as an
// HMAC bound to the phone and purpose, valid for VERIFY_CODE_TTL_MINUTES, and
// good for VERIFY_MAX_ATTEMPTS tries. Asking again replaces the earlier code.
//
// Table: phone_verification_codes (sql/nextgent_phone.sql).

const crypto = require('crypto');
const supabase = require('../db');
const telephony = require('./telephony');
const { envInt, envStr } = require('./env');

const digits = () => Math.min(envInt('VERIFY_CODE_DIGITS', 6), 9);
const ttlMinutes = () => envInt('VERIFY_CODE_TTL_MINUTES', 10);
const maxAttempts = () => envInt('VERIFY_MAX_ATTEMPTS', 5);

function secret() {
    const s = envStr('VERIFY_CODE_SECRET') || envStr('NEXTGENT_SERVICE_SECRET');
    if (!s) throw Object.assign(new Error('VERIFY_CODE_SECRET (or NEXTGENT_SERVICE_SECRET) is not set.'), { status: 503 });
    return s;
}

const hash = (phone, purpose, code) => crypto.createHmac('sha256', secret()).update(`${purpose}:${phone}:${code}`).digest('hex');

function newCode() {
    const n = digits();
    return String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
}

/** The text the code goes out in. VERIFY_CODE_MESSAGE may carry {code} and {minutes}. */
function messageFor(code) {
    const template = envStr('VERIFY_CODE_MESSAGE', 'Your verification code is {code}. It expires in {minutes} minutes.');
    return template.replace(/\{code\}/g, code).replace(/\{minutes\}/g, String(ttlMinutes()));
}

/**
 * Send a fresh code. Resolves { sent: true, expiresAt } or throws with
 * err.status (400 bad phone, 503 not configured, 502 the carrier refused).
 */
async function startVerification(rawPhone, { purpose = 'sign_in' } = {}) {
    const phone = telephony.normalizePhone(rawPhone);
    if (!phone) throw Object.assign(new Error('Valid phone number required'), { status: 400 });
    if (!telephony.isConfigured()) throw Object.assign(new Error('Texting is not configured on this server.'), { status: 503 });

    const code = newCode();
    const expiresAt = new Date(Date.now() + ttlMinutes() * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    // One live code per phone and purpose: asking again supersedes the last.
    await supabase.from('phone_verification_codes')
        .update({ consumed_at: now })
        .eq('phone', phone).eq('purpose', purpose).is('consumed_at', null);

    const { error } = await supabase.from('phone_verification_codes').insert({
        phone, purpose, code_hash: hash(phone, purpose, code), expires_at: expiresAt, attempts: 0,
    });
    if (error) throw Object.assign(new Error(`Could not store the code: ${error.message}`), { status: 503 });

    try {
        await telephony.sendSms({ to: phone, text: messageFor(code) });
    } catch (err) {
        throw Object.assign(new Error(`Could not send the code: ${err.message}`), { status: 502 });
    }
    return { sent: true, phone, expiresAt };
}

/** { ok: true } or { ok: false, reason } — never throws for a wrong code. */
async function checkVerification(rawPhone, code, { purpose = 'sign_in', now = new Date() } = {}) {
    const phone = telephony.normalizePhone(rawPhone);
    const given = String(code || '').trim();
    if (!phone || !/^\d{4,9}$/.test(given)) return { ok: false, reason: 'Incorrect code' };

    const { data: rows, error } = await supabase.from('phone_verification_codes')
        .select('id, code_hash, expires_at, attempts')
        .eq('phone', phone).eq('purpose', purpose).is('consumed_at', null)
        .order('created_at', { ascending: false }).limit(1);
    if (error) return { ok: false, reason: 'Verification is not available right now.' };
    const row = rows?.[0];
    if (!row) return { ok: false, reason: 'No code is waiting for this number. Ask for a new one.' };
    if (new Date(row.expires_at) < now) return { ok: false, reason: 'That code expired. Ask for a new one.' };
    if ((row.attempts || 0) >= maxAttempts()) return { ok: false, reason: 'Too many tries. Ask for a new code.' };

    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(hash(phone, purpose, given), 'hex');
    const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!match) {
        await supabase.from('phone_verification_codes').update({ attempts: (row.attempts || 0) + 1 }).eq('id', row.id);
        return { ok: false, reason: 'Incorrect code' };
    }
    await supabase.from('phone_verification_codes').update({ consumed_at: now.toISOString() }).eq('id', row.id);
    return { ok: true, phone };
}

module.exports = { startVerification, checkVerification, _hash: hash };
