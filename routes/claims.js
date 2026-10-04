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
const phoneCodes = require('../lib/phoneVerification');
const { notifyPlatform } = require('../lib/notify');
const { envInt } = require('../lib/env');

const router = express.Router();

const fail = (res, status, error, extra) => res.status(status).json({ error, ...(extra || {}) });
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Tunables, from env (documented in .env.example). The code itself — digits,
// how long it lasts, how many tries, its secret — is lib/phoneVerification.js
// (VERIFY_*), the one copy of phone codes; this file only adds how often a
// listing may be rung.
const maxStartsPerHour = () => envInt('CLAIM_MAX_STARTS_PER_HOUR', 5);

/** A claim's code is a phone code for this purpose, so it cannot be used for another claim. */
const purposeFor = (claimId) => `claim:${claimId}`;

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
    // …and a business's phone cannot be rung without limit by many companies.
    const { data: rung } = await supabase.from('claim_codes').select('id')
        .eq('entity_slug', slug).gte('created_at', since);
    if ((rung || []).length >= maxStartsPerHour()) return fail(res, 429, 'This business has been sent too many codes this hour. Try again later or ask for review.');

    let channel = 'voice';
    try {
        const line = await telephony.lookupNumber(phone);
        if (line.canText) channel = 'sms';
    } catch (err) {
        // Unknown line type: a call reaches a mobile and a landline alike.
        console.warn('[claims] number lookup failed, calling instead:', err.message);
    }

    const claimId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + phoneCodes.codeLifetimeMinutes() * 60 * 1000).toISOString();

    // The claim record. The code itself lives with lib/phoneVerification.js.
    const { error: insertError } = await supabase.from('claim_codes').insert({
        id: claimId,
        company_id: req.paperclip.companyId,
        paperclip_user_id: req.paperclip.userId,
        entity_slug: slug,
        phone,
        channel,
        expires_at: expiresAt,
    });
    if (insertError) return fail(res, 503, `Claims are not set up on this database yet: ${insertError.message}`);

    try {
        await phoneCodes.startVerification(phone, {
            purpose: purposeFor(claimId),
            // By text when the line takes texts, by an automated call that reads
            // the digits when it does not — always to the listing's phone.
            deliver: ({ code, minutes }) => (channel === 'sms'
                ? telephony.sendSms({
                    to: phone,
                    from: process.env.PLATFORM_NUMBER || undefined,
                    text: `${code} is the code to claim ${entity.name}. It expires in ${minutes} minutes. If you did not ask for it, ignore this text.`,
                })
                : telephony.placeCall({
                    to: phone,
                    from: process.env.PLATFORM_NUMBER || undefined,
                    say: `This is an automated call. The code to claim ${entity.name} is ${spoken(code)}. Again, ${spoken(code)}.`,
                    clientState: { purpose: 'claim', claimId },
                })),
        });
    } catch (err) {
        await supabase.from('claim_codes').update({ expires_at: new Date().toISOString() }).eq('id', claimId);
        if (err.status === 502) return fail(res, 502, `Could not reach the listing's phone: ${err.message.replace(/^Could not send the code: /, '')}`, { reviewAvailable: true });
        return fail(res, err.status || 500, err.message);
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

    // One copy of the check, tries and expiry: lib/phoneVerification.js.
    const result = await phoneCodes.checkVerification(claim.phone, code, { purpose: purposeFor(claimId) });
    if (!result.ok) {
        switch (result.code) {
        case 'mismatch':
        case 'invalid':
            return fail(res, 400, 'That code is not right.', result.attemptsLeft !== undefined ? { attemptsLeft: result.attemptsLeft } : undefined);
        case 'too_many': return fail(res, 429, 'Too many tries. Ask for a new code.');
        case 'busy': return fail(res, 409, 'Try again.');
        case 'unavailable': return fail(res, 503, result.reason);
        default: return fail(res, 410, 'That code has expired. Ask for a new one.');
        }
    }

    try {
        await linkCompany({ companyId: claim.company_id, slug: claim.entity_slug, linkedBy: `paperclip:${req.paperclip.userId}` });
    } catch (err) {
        return fail(res, err.status || 500, err.message);
    }
    await supabase.from('claim_codes').update({ verified_at: new Date().toISOString() }).eq('id', claimId);
    res.json({ linked: true, entitySlug: claim.entity_slug });
});

module.exports = router;
