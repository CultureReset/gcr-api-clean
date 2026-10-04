// ============================================================
// PHONE VERIFICATION — our own codes, sent through lib/telephony
// ============================================================
//
// The one copy of phone codes. What Twilio Verify used to do, done here so it
// works on whichever carrier is live (Telnyx by default). Used by tourist
// sign-in (routes/tourist-auth.js), business sign-up and sign-in
// (routes/business-auth.js) and claiming a listing (routes/claims.js, purpose
// `claim:<claim id>`, which may deliver the code by an automated call).
//
// A code is a random number of VERIFY_CODE_DIGITS digits, sent from the
// platform sender (or delivered by the caller's own `deliver`), stored only as
// an HMAC bound to the phone and purpose, valid for VERIFY_CODE_TTL_MINUTES,
// and good for VERIFY_MAX_ATTEMPTS tries. Each try is counted before it is
// checked, and only if nobody else counted it first, so two guesses in flight
// cannot share one try. Asking again replaces the earlier code.
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
 * Send a fresh code. Resolves { sent: true, phone, expiresAt } or throws with
 * err.status (400 bad phone, 503 not configured, 502 it could not be sent).
 *
 * @param {object}   [o]
 * @param {string}   [o.purpose]  what the code is for; a code only checks for its own purpose
 * @param {Function} [o.deliver]  async ({ phone, code, minutes }) — send it another way (a
 *                                call, a different text); default: a text of VERIFY_CODE_MESSAGE
 */
async function startVerification(rawPhone, { purpose = 'sign_in', deliver = null } = {}) {
    const phone = telephony.normalizePhone(rawPhone);
    if (!phone) throw Object.assign(new Error('Valid phone number required'), { status: 400 });
    if (!telephony.isConfigured()) throw Object.assign(new Error('Texting is not configured on this server.'), { status: 503 });

    const code = newCode();
    const minutes = ttlMinutes();
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    // One live code per phone and purpose: asking again supersedes the last.
    await supabase.from('phone_verification_codes')
        .update({ consumed_at: now })
        .eq('phone', phone).eq('purpose', purpose).is('consumed_at', null);

    const { data: stored, error } = await supabase.from('phone_verification_codes').insert({
        phone, purpose, code_hash: hash(phone, purpose, code), expires_at: expiresAt, attempts: 0,
    }).select('id');
    if (error) throw Object.assign(new Error(`Could not store the code: ${error.message}`), { status: 503 });

    try {
        if (deliver) await deliver({ phone, code, minutes });
        else await telephony.sendSms({ to: phone, text: messageFor(code) });
    } catch (err) {
        // A code nobody received is no use to anybody.
        const id = stored?.[0]?.id;
        if (id) await supabase.from('phone_verification_codes').update({ consumed_at: new Date().toISOString() }).eq('id', id);
        throw Object.assign(new Error(`Could not send the code: ${err.message}`), { status: 502 });
    }
    return { sent: true, phone, expiresAt };
}

/**
 * Check a code. Never throws for a wrong one.
 *
 * Resolves { ok: true, phone } or { ok: false, reason, code, attemptsLeft? },
 * where `code` says why: invalid | none | expired | too_many | busy |
 * mismatch | unavailable. `consume: false` checks without using the code up
 * (a sign-up form confirming the code before it asks for the rest), and does
 * not spend a try when the code is right.
 */
async function checkVerification(rawPhone, code, { purpose = 'sign_in', now = new Date(), consume = true } = {}) {
    const phone = telephony.normalizePhone(rawPhone);
    const given = String(code || '').replace(/\s+/g, '');
    const no = (why, reason, extra) => ({ ok: false, code: why, reason, ...(extra || {}) });
    if (!phone || !/^\d{4,9}$/.test(given)) return no('invalid', 'Incorrect code');

    const { data: rows, error } = await supabase.from('phone_verification_codes')
        .select('id, code_hash, expires_at, attempts')
        .eq('phone', phone).eq('purpose', purpose).is('consumed_at', null)
        .order('created_at', { ascending: false }).limit(1);
    if (error) return no('unavailable', 'Verification is not available right now.');
    const row = rows?.[0];
    if (!row) return no('none', 'No code is waiting for this number. Ask for a new one.');
    if (new Date(row.expires_at) < now) return no('expired', 'That code expired. Ask for a new one.');
    const tried = row.attempts || 0;
    if (tried >= maxAttempts()) return no('too_many', 'Too many tries. Ask for a new code.');

    // Count this try first, and only if nobody else counted it.
    const { data: counted } = await supabase.from('phone_verification_codes')
        .update({ attempts: tried + 1 })
        .eq('id', row.id).eq('attempts', tried)
        .select('id');
    if (!counted?.length) return no('busy', 'Try again.');

    let match = false;
    try {
        const expected = Buffer.from(row.code_hash, 'hex');
        const actual = Buffer.from(hash(phone, purpose, given), 'hex');
        match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (err) {
        return no('unavailable', err.message);
    }
    if (!match) return no('mismatch', 'Incorrect code', { attemptsLeft: Math.max(0, maxAttempts() - (tried + 1)) });

    if (consume) {
        await supabase.from('phone_verification_codes').update({ consumed_at: now.toISOString() }).eq('id', row.id);
    } else {
        // A right code checked ahead of time does not use up a try.
        await supabase.from('phone_verification_codes').update({ attempts: tried }).eq('id', row.id).eq('attempts', tried + 1);
    }
    return { ok: true, phone };
}

module.exports = { startVerification, checkVerification, codeLifetimeMinutes: ttlMinutes, _hash: hash };
