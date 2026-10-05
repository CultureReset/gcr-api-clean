// ============================================================
// PLATFORM TEXT — Paperclip sends a text from the platform number (DECISIONS #85)
// ============================================================
//
//   POST /api/nextgent/platform-text   { companyId, to, body, kind?, ref? }
//
// Platform notifications (owner notices, billing, invites) move to Paperclip,
// but there is one telephony integration and it lives here (#4: Telnyx,
// lib/telephony). So Paperclip asks gcr to send the text, signed like every
// other service call (CONTRACT §3), and gcr sends it from PLATFORM_NUMBER the
// way lib/notify.js sends an owner notification: through utils/sms.js, which
// honours the platform-wide STOP list (sms_opt_outs) and logs every attempt
// to sms_log — sent, opted_out, failed — under the business the company is
// linked to, type platform_<kind>.
//
//   companyId   must be linked to a business (lib/companyLinks.js); the log
//               is kept under that business. 409 otherwise.
//   to          a phone number (normalised here). The answer never echoes it.
//   body        the text, as given.
//   kind        a short lower-case label for the log (billing, notice, …);
//               default platform.
//   ref         optional, what the text is about (an invoice id, …), kept on
//               the log row.
//
// Answers { sent: true, id } (200); { sent: false, reason: 'opted_out' } (200,
// a rule, not a failure); { sent: false, reason } (502) when the carrier or
// its configuration fails.
//
// There is deliberately no /platform-email twin: Paperclip has its own mailer
// (DECISIONS #85).
//
// Mounted by routes/nextgent.js behind its serviceSigned check. It also
// refuses on its own when that check did not run (req.nextgentService unset),
// so a wrong mount cannot open it.

const express = require('express');
const { slugForCompany } = require('../lib/companyLinks');
const { normalizePhone } = require('../lib/telephony');
const { sendSms } = require('../utils/sms');

const router = express.Router();

const fail = (res, status, error, extra) => res.status(status).json({ error, ...(extra || {}) });
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const KIND = /^[a-z][a-z0-9_-]{0,39}$/;
const DEFAULT_KIND = 'platform';
const MAX_BODY = 1600; // ten SMS segments; a longer platform text is a mistake, not a message

router.post('/platform-text', async (req, res) => {
    if (!req.nextgentService) return fail(res, 401, 'Service signature required.');
    const b = req.body || {};
    const companyId = str(b.companyId);
    const body = str(b.body);
    const kind = b.kind === undefined || b.kind === null || b.kind === '' ? DEFAULT_KIND : str(b.kind);
    const ref = b.ref === undefined || b.ref === null ? null : str(b.ref).slice(0, 200) || null;
    if (!companyId || !str(b.to) || !body) return fail(res, 400, 'companyId, to and body are required.');
    if (body.length > MAX_BODY) return fail(res, 400, `body is longer than ${MAX_BODY} characters.`);
    if (!KIND.test(kind)) return fail(res, 400, 'kind must be a short lower-case label (a-z, 0-9, _ or -).');
    const to = normalizePhone(b.to);
    if (!to) return fail(res, 400, 'to is not a phone number.');

    let slug;
    try {
        slug = await slugForCompany(companyId);
    } catch (err) {
        return fail(res, 500, err.message);
    }
    if (!slug) return fail(res, 409, 'This company is not linked to a business.');

    const out = await sendSms(to, body, slug, `platform_${kind}`, ref, process.env.PLATFORM_NUMBER || null);
    if (out?.success) return res.json({ sent: true, id: out.id || out.sid || null });
    if (out?.reason === 'opted_out') return res.json({ sent: false, reason: 'opted_out' });
    return res.status(502).json({ sent: false, reason: out?.reason || 'failed' });
});

module.exports = router;
