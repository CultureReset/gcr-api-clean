// ============================================================
// /api/claims — claim a listed business with a code to its phone (plan §5)
// ============================================================
//
// Signed in with a Paperclip business token whose company is NOT linked yet
// (middleware/ownerAuth.js paperclipRequired) — these two routes exist to
// create that link.
//
//   POST /start    { entitySlug, method?: 'code' | 'review', message?, contact? }
//                  'code' (default): a code goes to the phone ON THE LISTING —
//                  by text from PLATFORM_NUMBER when the line takes texts, by an
//                  automated call when it does not. Never to a number the
//                  caller supplies: whoever answers the listing's phone is the
//                  business.
//                  'review', or no usable phone: the claim goes to an admin
//                  (the existing business_claims queue); approving it there
//                  links the company.
//   POST /verify   { claimId, code } -> links the company on a match.
//
// The slug in /start names the listing being claimed; it grants nothing until
// the code comes back from that listing's phone.

const crypto = require('crypto');
const express = require('express');
const supabase = require('../db');
const { paperclipRequired } = require('../middleware/ownerAuth');
const { companyForSlug, linkCompany } = require('../lib/companyLinks');
const telephony = require('../lib/telephony');
const { notifyPlatform } = require('../lib/notify');

const router = express.Router();

const fail = (res, status, error, extra) => res.status(status).json({ error, ...(extra || {}) });
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Tunables, from env (documented in .env.example). The fallbacks keep a
// missing variable from disabling claims, not from being configured.
const envInt = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n > 0 ? n : fallback;
};
const codeDigits = () => Math.min(envInt('CLAIM_CODE_DIGITS', 6), 9);
const codeTtlMinutes = () => envInt('CLAIM_CODE_TTL_MINUTES', 10);
const maxAttempts = () => envInt('CLAIM_MAX_ATTEMPTS', 5);
const maxStartsPerHour = () => envInt('CLAIM_MAX_STARTS_PER_HOUR', 5);

function codeSecret() {
    const s = process.env.CLAIM_CODE_SECRET || process.env.NEXTGENT_SERVICE_SECRET;
    if (!s) throw Object.assign(new Error('CLAIM_CODE_SECRET (or NEXTGENT_SERVICE_SECRET) is not set.'), { status: 503 });
    return s;
}

/** HMAC of the code bound to its claim id, so a hash cannot be replayed onto another claim. */
const hashCode = (claimId, code) => crypto.createHmac('sha256', codeSecret()).update(`${claimId}:${code}`).digest('hex');

function newCode() {
    const digits = codeDigits();
    return String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
}

/** "4 8 1 5 1 6" — read digit by digit on a call. */
const spoken = (code) => code.split('').join(' ');

async function fileForReview(req, entity, reason) {
    const contact = req.body?.contact || {};
    const row = {
        business_name: entity.name,
        entity_slug: entity.slug,
        contact_name: str(contact.name) || null,
        phone: str(contact.phone) || entity.phone || '',
        email: str(contact.email) || null,
        message: [str(req.body?.message), reason ? `[${reason}]` : ''].filter(Boolean).join(' ') || null,
        status: 'new',
        paperclip_company_id: req.paperclip.companyId,
        paperclip_user_id: req.paperclip.userId,
        created_at: new Date().toISOString(),
    };
    let { data, error } = await supabase.from('business_claims').insert(row).select('id').single();
    if (error && /(paperclip_|entity_slug)/.test(error.message || '')) {
        // sql/nextgent_link.sql not applied yet: keep the claim, and keep who
        // asked in the message so an admin can still link it by hand.
        const { paperclip_company_id, paperclip_user_id, entity_slug, ...base } = row;
        base.message = [`[company ${paperclip_company_id} / user ${paperclip_user_id} / listing ${entity_slug}]`, row.message].filter(Boolean).join(' ');
        ({ data, error } = await supabase.from('business_claims').insert(base).select('id').single());
    }
    if (error) throw new Error(`Could not file the claim: ${error.message}`);
    notifyPlatform({
        title: `Claim waiting for review: ${entity.name}`,
        body: `A company asked to claim ${entity.name} (${entity.slug}).${reason ? ` Reason for review: ${reason}.` : ''}`,
    });
    return data.id;
}

/* ── POST /start ──────────────────────────────────────────────────────── */

router.post('/start', paperclipRequired, async (req, res) => {
    if (req.entitySlug) return fail(res, 409, 'This company is already linked to a business.', { entitySlug: req.entitySlug });

    const slug = str(req.body?.entitySlug);
    if (!slug) return fail(res, 400, 'entitySlug is required.');
    const method = str(req.body?.method) || 'code';
    if (!['code', 'review'].includes(method)) return fail(res, 400, "method must be 'code' or 'review'.");

    const { data: entity, error } = await supabase.from('entity').select('slug, name, phone').eq('slug', slug).maybeSingle();
    if (error) return fail(res, 500, error.message);
    if (!entity) return fail(res, 404, 'No such business.');

    try {
        if (await companyForSlug(slug)) return fail(res, 409, 'That business is already claimed.');
    } catch (err) {
        return fail(res, 500, err.message);
    }

    // Already owned through the old dashboard sign-in: a code would hand it
    // over to whoever answers the phone, so it goes to a person instead.
    const { data: owners } = await supabase.from('entity_owners').select('entity_slug').eq('entity_slug', slug).limit(1);
    const owned = !!(owners && owners.length);
    const phone = telephony.normalizePhone(entity.phone);

    let reviewReason = null;
    if (method === 'review') reviewReason = null;
    else if (owned) reviewReason = 'already has an owner';
    else if (!phone) reviewReason = 'listing has no usable phone';
    else if (!telephony.isConfigured()) reviewReason = 'telephony not configured';

    if (method === 'review' || reviewReason) {
        try {
            const claimId = await fileForReview(req, entity, reviewReason);
            return res.status(202).json({ status: 'review', claimId, reason: reviewReason });
        } catch (err) {
            return fail(res, 500, err.message);
        }
    }

    // A company cannot ring a business's phone without limit.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase.from('claim_codes').select('id')
        .eq('company_id', req.paperclip.companyId).gte('created_at', since);
    if ((recent || []).length >= maxStartsPerHour()) return fail(res, 429, 'Too many codes this hour. Try again later or ask for review.');

    let channel = 'voice';
    try {
        const line = await telephony.lookupNumber(phone);
        if (line.canText) channel = 'sms';
    } catch (err) {
        // Unknown line type: a call reaches a mobile and a landline alike.
        console.warn('[claims] number lookup failed, calling instead:', err.message);
    }

    const claimId = crypto.randomUUID();
    const code = newCode();
    const expiresAt = new Date(Date.now() + codeTtlMinutes() * 60 * 1000).toISOString();
    let codeHash;
    try {
        codeHash = hashCode(claimId, code);
    } catch (err) {
        return fail(res, err.status || 500, err.message);
    }

    const { error: insertError } = await supabase.from('claim_codes').insert({
        id: claimId,
        company_id: req.paperclip.companyId,
        paperclip_user_id: req.paperclip.userId,
        entity_slug: slug,
        phone,
        channel,
        code_hash: codeHash,
        expires_at: expiresAt,
    });
    if (insertError) return fail(res, 503, `Claims are not set up on this database yet: ${insertError.message}`);

    try {
        if (channel === 'sms') {
            await telephony.sendSms({
                to: phone,
                from: process.env.PLATFORM_NUMBER || undefined,
                text: `${code} is the code to claim ${entity.name}. It expires in ${codeTtlMinutes()} minutes. If you did not ask for it, ignore this text.`,
            });
        } else {
            await telephony.placeCall({
                to: phone,
                from: process.env.PLATFORM_NUMBER || undefined,
                say: `This is an automated call. The code to claim ${entity.name} is ${spoken(code)}. Again, ${spoken(code)}.`,
                clientState: { purpose: 'claim', claimId },
            });
        }
    } catch (err) {
        await supabase.from('claim_codes').update({ expires_at: new Date().toISOString() }).eq('id', claimId);
        return fail(res, 502, `Could not reach the listing's phone: ${err.message}`, { reviewAvailable: true });
    }

    res.status(201).json({ status: 'code_sent', claimId, channel, phoneHint: telephony.phoneHint(phone), expiresAt });
});

/* ── POST /verify ─────────────────────────────────────────────────────── */

router.post('/verify', paperclipRequired, async (req, res) => {
    const claimId = str(req.body?.claimId);
    const code = str(req.body?.code).replace(/\s+/g, '');
    if (!claimId || !code) return fail(res, 400, 'claimId and code are required.');

    const { data: claim, error } = await supabase.from('claim_codes').select('*').eq('id', claimId).maybeSingle();
    if (error) return fail(res, 500, error.message);
    // Another company's claim reads as not found, not as a hint it exists.
    if (!claim || claim.company_id !== req.paperclip.companyId) return fail(res, 404, 'No such claim.');
    if (claim.verified_at) return fail(res, 409, 'That code was already used.');
    if (new Date(claim.expires_at).getTime() < Date.now()) return fail(res, 410, 'That code has expired. Ask for a new one.');
    if (claim.attempts >= maxAttempts()) return fail(res, 429, 'Too many tries. Ask for a new code.');

    // Count the attempt before checking it, and only if nobody else counted
    // it first: two guesses in flight cannot share one attempt.
    const used = claim.attempts + 1;
    const { data: counted } = await supabase.from('claim_codes')
        .update({ attempts: used })
        .eq('id', claimId).eq('attempts', used - 1)
        .select('id');
    if (!counted?.length) return fail(res, 409, 'Try again.');

    let match = false;
    try {
        const expected = Buffer.from(hashCode(claimId, code), 'hex');
        const stored = Buffer.from(claim.code_hash, 'hex');
        match = expected.length === stored.length && crypto.timingSafeEqual(expected, stored);
    } catch (err) {
        return fail(res, err.status || 500, err.message);
    }
    if (!match) return fail(res, 400, 'That code is not right.', { attemptsLeft: Math.max(0, maxAttempts() - used) });

    try {
        await linkCompany({ companyId: claim.company_id, slug: claim.entity_slug, linkedBy: `paperclip:${req.paperclip.userId}` });
    } catch (err) {
        return fail(res, err.status || 500, err.message);
    }
    await supabase.from('claim_codes').update({ verified_at: new Date().toISOString() }).eq('id', claimId);
    res.json({ linked: true, entitySlug: claim.entity_slug });
});

module.exports = router;
