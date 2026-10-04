// ============================================================
// OWNER NOTIFICATIONS — email and text, before any app exists (plan §6)
// ============================================================
//
// What reaches a business's owner when something needs them:
//
//   review          an item is waiting in the review queue
//   unknown_sender  forwarded mail from a sender this business has not seen
//   approval        something is waiting for the owner's yes
//   failed_action   something the platform tried for them did not work
//
// Email goes through utils/email.js (Brevo). Texts go from PLATFORM_NUMBER
// through utils/sms.js, so opt-outs and the sms_log apply as for every text.
//
// Where it goes: owner_notify_settings for the business, else the listing's
// own email and phone. Only a business someone has claimed is notified (a
// company link or an entity_owners row) — a listing nobody owns is not texted.
//
// Every attempt is logged to owner_notifications, including the skipped ones
// and why. With a `ref`, the same item is never announced twice.
//
// notify() never throws: a notification failing must not fail the thing that
// triggered it.

const supabase = require('../db');
const { sendEmail } = require('../utils/email');
const { sendSms } = require('../utils/sms');

const KINDS = Object.freeze(['review', 'unknown_sender', 'approval', 'failed_action']);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** An absolute link, or a path joined to OWNER_APP_URL, or nothing. */
function linkFor(link) {
    if (!link) return null;
    if (/^https?:\/\//i.test(link)) return link;
    const base = process.env.OWNER_APP_URL;
    return base ? `${base.replace(/\/+$/, '')}/${String(link).replace(/^\/+/, '')}` : null;
}

async function isClaimed(slug) {
    const [{ data: link }, { data: owner }] = await Promise.all([
        supabase.from('company_links').select('company_id').eq('entity_slug', slug).maybeSingle(),
        supabase.from('entity_owners').select('entity_slug').eq('entity_slug', slug).limit(1),
    ]);
    return !!link || !!(owner && owner.length);
}

async function contactsFor(slug) {
    const { data: settings } = await supabase
        .from('owner_notify_settings')
        .select('email, phone, email_on, sms_on, muted_kinds')
        .eq('entity_slug', slug)
        .maybeSingle();
    let email = settings?.email || null;
    let phone = settings?.phone || null;
    if (!email || !phone) {
        const { data: entity } = await supabase.from('entity').select('email, phone').eq('slug', slug).maybeSingle();
        email = email || entity?.email || null;
        phone = phone || entity?.phone || null;
    }
    return {
        email: settings?.email_on === false ? null : email,
        phone: settings?.sms_on === false ? null : phone,
        muted: new Set(settings?.muted_kinds || []),
    };
}

async function alreadySent(slug, kind, ref) {
    if (!ref) return false;
    const { data } = await supabase
        .from('owner_notifications')
        .select('id')
        .eq('entity_slug', slug)
        .eq('kind', kind)
        .eq('ref', String(ref))
        .limit(1);
    return !!(data && data.length);
}

async function log(slug, kind, ref, title, channels) {
    try {
        await supabase.from('owner_notifications').insert({
            entity_slug: slug, kind, ref: ref ? String(ref) : null, title, channels,
        });
    } catch {
        // The log is for visibility; it must not take the notification down.
    }
}

function emailHtml({ title, body, link }) {
    return `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2 style="font-size:18px">${esc(title)}</h2>
${body ? `<p style="white-space:pre-wrap">${esc(body)}</p>` : ''}
${link ? `<p><a href="${esc(link)}">Open it</a></p>` : ''}
</div>`;
}

/**
 * Tell a business's owner about something.
 *
 * @param {string} slug
 * @param {{ kind: string, title: string, body?: string, ref?: string, link?: string }} msg
 * @returns {Promise<{ sent: boolean, channels?: object, skipped?: string }>}
 */
async function notifyOwner(slug, { kind, title, body, ref, link } = {}) {
    try {
        if (!slug) return { sent: false, skipped: 'no_business' };
        if (!KINDS.includes(kind)) return { sent: false, skipped: 'unknown_kind' };
        if (!title) return { sent: false, skipped: 'no_title' };

        if (!(await isClaimed(slug))) return { sent: false, skipped: 'not_claimed' };
        if (await alreadySent(slug, kind, ref)) return { sent: false, skipped: 'duplicate' };

        const to = await contactsFor(slug);
        if (to.muted.has(kind)) {
            await log(slug, kind, ref, title, { skipped: 'muted' });
            return { sent: false, skipped: 'muted' };
        }

        const url = linkFor(link);
        const channels = {};
        if (to.email) {
            const r = await sendEmail({ to: to.email, subject: title, html: emailHtml({ title, body, link: url }) });
            channels.email = r?.success ? 'sent' : (r?.reason || 'failed');
        }
        if (to.phone) {
            const text = [title, url].filter(Boolean).join(' ');
            const r = await sendSms(to.phone, text, slug, `notify_${kind}`, ref || null, process.env.PLATFORM_NUMBER || null);
            channels.sms = r?.success ? 'sent' : (r?.reason || 'failed');
        }
        if (!to.email && !to.phone) channels.skipped = 'no_contact';

        await log(slug, kind, ref, title, channels);
        const sent = channels.email === 'sent' || channels.sms === 'sent';
        return { sent, channels };
    } catch (err) {
        console.error('[notify]', kind, slug, err.message);
        return { sent: false, skipped: 'error' };
    }
}

/** Tell the platform operator (PLATFORM_ADMIN_EMAIL) — e.g. a claim waiting for review. */
async function notifyPlatform({ title, body, link } = {}) {
    try {
        const to = process.env.PLATFORM_ADMIN_EMAIL;
        if (!to) return { sent: false, skipped: 'no_admin_email' };
        const r = await sendEmail({ to, subject: title, html: emailHtml({ title, body, link: linkFor(link) }) });
        return { sent: !!r?.success };
    } catch (err) {
        console.error('[notify] platform', err.message);
        return { sent: false, skipped: 'error' };
    }
}

module.exports = { KINDS, notifyOwner, notifyPlatform };
