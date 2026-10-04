// ============================================================
// /api/nextgent — the calls Paperclip makes (CONTRACT §4)
// ============================================================
//
// Every route here is service-to-service: the request must carry Paperclip's
// HMAC signature (lib/serviceSigning.js, CONTRACT §3). There is no user here,
// so nothing is resolved from a session; a company is resolved to its business
// through company_links, the only place that says which.
//
//   POST   /link                   link a company to a business (new or claimed)
//   POST   /installs               an agent, app or automation was installed
//   DELETE /installs/:installId    …and removed
//   GET    /entitlement            may this company have this item, and at what price
//   POST   /unlink                 the business leaves (export first if asked)
//   POST   /usage                  AI spend from LiteLLM, per company and period
//
// Tokens are returned once, in the response that created them. Only their
// hashes are stored (lib/businessTokens.js).

const express = require('express');
const supabase = require('../db');
const { serviceSigned } = require('../lib/serviceSigning');
const { slugForCompany, linkCompany, unlinkCompany } = require('../lib/companyLinks');
const { mintToken, revokeWhere } = require('../lib/businessTokens');
const { RESOURCES, normalizePermissions, scopeForPermissions } = require('../lib/businessTables');
const { forwardingAddressFor } = require('../lib/forwardingAddress');
const { findExistingEntity } = require('../lib/find-existing-entity');
const { normalizePhone } = require('../lib/telephony');
const entitlements = require('../lib/entitlements');
const billingStripe = require('../lib/billingStripe');
const secretBox = require('../lib/secretBox');
const { exportBusiness } = require('../lib/exportBusiness');

const router = express.Router();
router.use(serviceSigned);

const fail = (res, status, error, extra) => res.status(status).json({ error, ...(extra || {}) });
const KINDS = new Set(['agent', 'app', 'automation']);
const ROUTINE_SECRET_PURPOSE = 'routine-webhook-secret';
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Every resource, read and write: the company-level token Jarvis acts with. */
const COMPANY_PERMISSIONS = RESOURCES.flatMap((r) => [`${r}:read`, `${r}:write`]);

/* ── helpers ──────────────────────────────────────────────────────────── */

async function uniqueSlug(name) {
    const base = String(name).toLowerCase().normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!base) throw Object.assign(new Error('That name has nothing to make an address from.'), { status: 400 });
    const { data } = await supabase.from('entity').select('slug').or(`slug.eq.${base},slug.like.${base}-%`);
    const taken = new Set((data || []).map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    return `${base}-${Date.now().toString(36)}`;
}

/**
 * Create a new, unpublished business. A phone that already belongs to a
 * listing is refused: that business exists, and taking it over is the claim
 * flow (/api/claims), which proves it.
 */
async function createEntity(create) {
    const name = str(create?.name);
    const kind = str(create?.kind);
    if (!name || !kind) throw Object.assign(new Error('create needs name and kind.'), { status: 400 });
    const phone = create.phone ? normalizePhone(create.phone) : null;
    if (create.phone && !phone) throw Object.assign(new Error('create.phone is not a phone number.'), { status: 400 });

    if (phone) {
        const existing = await findExistingEntity(supabase, { phone });
        if (existing) {
            throw Object.assign(new Error('A business with that phone number is already listed.'), {
                status: 409, extra: { claimInstead: { slug: existing.slug, name: existing.name } },
            });
        }
    }

    const slug = await uniqueSlug(name);
    const row = {
        slug,
        name,
        entity_type: kind,
        phone,
        website_url: str(create.website) || null,
        // Hidden until reviewed, like a self-serve sign-up.
        is_active: false,
        show_in_listings: false,
    };
    const address = str(create.address);
    let { error } = await supabase.from('entity').insert(address ? { ...row, address_line_1: address } : row);
    if (error && address && /address_line_1/.test(error.message || '')) {
        ({ error } = await supabase.from('entity').insert(row));
    }
    if (error) throw new Error(`Could not create the business: ${error.message}`);
    return slug;
}

async function liveCompanyToken(companyId) {
    const { data, error } = await supabase
        .from('business_mcp_tokens')
        .select('id')
        .eq('company_id', String(companyId))
        .is('install_id', null)
        .is('revoked_at', null)
        .limit(1);
    if (error) return null;
    return data?.[0] || null;
}

/* ── POST /link ───────────────────────────────────────────────────────── */

router.post('/link', async (req, res) => {
    const companyId = str(req.body?.companyId);
    const entitySlug = str(req.body?.entitySlug);
    const create = req.body?.create;
    if (!companyId) return fail(res, 400, 'companyId is required.');

    let slug;
    let created = false;
    try {
        const linked = await slugForCompany(companyId);
        if (linked) {
            if (entitySlug && entitySlug !== linked) return fail(res, 409, 'This company is already linked to another business.', { entitySlug: linked });
            slug = linked;
        } else if (!entitySlug && !create) {
            return fail(res, 400, 'Send entitySlug or create.');
        } else if (entitySlug) {
            // An existing listing is linked only once it is proven: a verified
            // claim code or an approved review claim creates the link, and
            // this call then completes the setup for it.
            return fail(res, 409, 'That business has to be claimed first.', { claimRequired: true });
        } else {
            slug = await createEntity(create);
            await linkCompany({ companyId, slug, linkedBy: 'paperclip:link' });
            created = true;
        }
    } catch (err) {
        return fail(res, err.status || 500, err.message, err.extra);
    }

    // The owner's contact for notifications, when Paperclip knows it.
    const notify = req.body?.notify;
    if (notify && (notify.email || notify.phone)) {
        const { data: has } = await supabase.from('owner_notify_settings').select('entity_slug').eq('entity_slug', slug).maybeSingle();
        if (!has) {
            await supabase.from('owner_notify_settings').insert({
                entity_slug: slug,
                email: str(notify.email) || null,
                phone: notify.phone ? normalizePhone(notify.phone) : null,
            });
        }
    }

    // The company-level token, returned once. A repeat call does not mint a
    // second; rotateToken revokes the old one and returns a new one.
    let businessToken = null;
    try {
        const existing = await liveCompanyToken(companyId);
        if (existing && req.body?.rotateToken === true) {
            await supabase.from('business_mcp_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', existing.id);
        }
        if (!existing || req.body?.rotateToken === true) {
            const minted = await mintToken({
                slug,
                label: `company:${companyId}`,
                scope: 'write',
                permissions: COMPANY_PERMISSIONS,
                companyId,
            });
            businessToken = minted.token;
        }
    } catch (err) {
        return fail(res, err.status || 500, err.message, { entitySlug: slug });
    }

    res.status(created ? 201 : 200).json({
        entitySlug: slug,
        forwardingAddress: forwardingAddressFor(slug),
        businessToken,
        ...(businessToken ? {} : { businessTokenIssued: true }),
        created,
    });
});

/* ── GET /entitlement ─────────────────────────────────────────────────── */

/**
 * The answer for one company and one item. Exported for /installs, which asks
 * the same question before it bills.
 */
async function entitlementFor(companyId, itemKey) {
    const slug = await slugForCompany(companyId);
    if (!slug) return { allowed: false, reason: 'not_linked' };

    const item = await billingStripe.itemByKey(itemKey);
    if (!item) {
        // Not in the billing catalog: nothing to charge and no plan rule to
        // apply. Paperclip's catalog decides whether it exists at all.
        return { allowed: true, reason: 'unpriced', priceCents: 0, interval: null, slug };
    }
    const { priceCents, interval } = billingStripe.priceOf(item);
    const ctx = await entitlements.contextFor(slug);
    const decision = ctx.decide(item);
    if (!decision.ok) return { allowed: false, reason: decision.reason, priceCents, interval, slug, item };

    if (priceCents > 0) {
        const state = await billingStripe.billingState(slug);
        if (state.paused) return { allowed: false, reason: 'paused', priceCents, interval, slug, item };
        if (!billingStripe.stripeConfigured()) return { allowed: false, reason: 'billing_unavailable', priceCents, interval, slug, item };
    }
    return { allowed: true, reason: decision.reason, priceCents, interval, slug, item };
}

router.get('/entitlement', async (req, res) => {
    const companyId = str(req.query.companyId);
    const itemKey = str(req.query.itemKey);
    if (!companyId || !itemKey) return fail(res, 400, 'companyId and itemKey are required.');
    try {
        const e = await entitlementFor(companyId, itemKey);
        const out = { allowed: e.allowed };
        if (e.reason) out.reason = e.reason;
        if (e.priceCents !== undefined) out.priceCents = e.priceCents;
        if (e.interval !== undefined) out.interval = e.interval;
        res.json(out);
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

/* ── POST /installs ───────────────────────────────────────────────────── */

router.post('/installs', async (req, res) => {
    const b = req.body || {};
    const companyId = str(b.companyId);
    const installId = str(b.installId);
    const itemKey = str(b.itemKey);
    const kind = str(b.kind);
    if (!companyId || !installId || !itemKey) return fail(res, 400, 'companyId, installId and itemKey are required.');
    if (!KINDS.has(kind)) return fail(res, 400, 'kind must be agent, app or automation.');

    let permissions;
    try {
        permissions = normalizePermissions(b.permissions || []);
    } catch (err) {
        return fail(res, 400, err.message);
    }

    const routine = b.routine;
    if (kind === 'automation' && routine) {
        if (!/^https:\/\//i.test(str(routine.webhookUrl)) || !str(routine.webhookSecret)) {
            return fail(res, 400, 'routine needs an https webhookUrl and a webhookSecret.');
        }
    }

    let slug;
    try {
        slug = await slugForCompany(companyId);
    } catch (err) {
        return fail(res, 500, err.message);
    }
    if (!slug) return fail(res, 409, 'This company is not linked to a business.');

    const { data: existing, error: readError } = await supabase
        .from('nextgent_installs').select('*').eq('install_id', installId).maybeSingle();
    if (readError) return fail(res, 503, `Installs are not set up on this database yet: ${readError.message}`);

    // An update of an install we already have: new version, or permissions
    // the owner approved since. The token keeps working with the new list.
    if (existing) {
        if (existing.company_id !== companyId) return fail(res, 409, 'That installId belongs to another company.');
        if (existing.status !== 'active') return fail(res, 409, 'That install was removed; install again with a new installId.');
        const patch = { permissions, version: b.version ?? existing.version, updated_at: new Date().toISOString() };
        if (kind === 'automation' && routine) {
            patch.routine_webhook_url = str(routine.webhookUrl);
            patch.routine_webhook_secret = secretBox.seal(str(routine.webhookSecret), ROUTINE_SECRET_PURPOSE);
        }
        const { error } = await supabase.from('nextgent_installs').update(patch).eq('install_id', installId);
        if (error) return fail(res, 500, error.message);
        await supabase.from('business_mcp_tokens')
            .update({ permissions, scope: scopeForPermissions(permissions) })
            .eq('install_id', installId).is('revoked_at', null);
        return res.json({ updated: true });
    }

    // New install: entitled, then billed, then recorded, then its token.
    let ent;
    try {
        ent = await entitlementFor(companyId, itemKey);
    } catch (err) {
        return fail(res, err.status || 500, err.message);
    }
    if (!ent.allowed) return fail(res, ent.reason === 'paused' ? 402 : 403, `Not allowed: ${ent.reason}`, { reason: ent.reason });

    let charge = { charged: false };
    if (ent.item && ent.priceCents > 0) {
        try {
            charge = await billingStripe.chargeInstall({ slug, companyId, installId, item: ent.item });
        } catch (err) {
            return fail(res, err.status || 502, `Billing failed: ${err.message}`);
        }
    }

    let sealedSecret = null;
    try {
        sealedSecret = kind === 'automation' && routine ? secretBox.seal(str(routine.webhookSecret), ROUTINE_SECRET_PURPOSE) : null;
    } catch (err) {
        if (charge.charged) await billingStripe.removeInstallCharge(installId);
        return fail(res, err.status || 500, err.message);
    }

    const { error: insertError } = await supabase.from('nextgent_installs').insert({
        install_id: installId,
        company_id: companyId,
        entity_slug: slug,
        item_key: itemKey,
        kind,
        version: b.version != null ? String(b.version) : null,
        permissions,
        routine_webhook_url: kind === 'automation' && routine ? str(routine.webhookUrl) : null,
        routine_webhook_secret: sealedSecret,
        status: 'active',
    });
    if (insertError) {
        if (charge.charged) await billingStripe.removeInstallCharge(installId);
        return fail(res, 500, insertError.message);
    }

    // Agents and apps get a token holding only what the owner approved.
    // Automations run inside this API and need none.
    let token;
    if (kind !== 'automation') {
        try {
            const minted = await mintToken({
                slug,
                label: `install:${itemKey}`,
                scope: scopeForPermissions(permissions),
                permissions,
                installId,
                companyId,
            });
            token = minted.token;
        } catch (err) {
            return fail(res, err.status || 500, err.message);
        }
    }

    res.status(201).json({
        ...(token ? { token } : {}),
        charged: !!charge.charged,
        ...(charge.charged ? { priceCents: charge.priceCents, interval: charge.interval } : {}),
    });
});

/* ── DELETE /installs/:installId ──────────────────────────────────────── */

router.delete('/installs/:installId', async (req, res) => {
    const installId = str(req.params.installId);
    try {
        const revoked = await revokeWhere({ install_id: installId });
        const { data } = await supabase
            .from('nextgent_installs')
            .update({ status: 'removed', removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('install_id', installId)
            .select('install_id');
        const charges = await billingStripe.removeInstallCharge(installId);
        if (!data?.length && !revoked) return fail(res, 404, 'No such install.');
        res.json({ removed: true, tokensRevoked: revoked, chargesRemoved: charges.removed });
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

/* ── POST /unlink ─────────────────────────────────────────────────────── */

router.post('/unlink', async (req, res) => {
    const companyId = str(req.body?.companyId);
    if (!companyId) return fail(res, 400, 'companyId is required.');

    let slug;
    try {
        slug = await slugForCompany(companyId);
    } catch (err) {
        return fail(res, 500, err.message);
    }
    if (!slug) return res.json({ unlinked: false, alreadyUnlinked: true });

    // Export first: if it fails, nothing has been torn down yet and the
    // owner can try again.
    let exported = null;
    if (req.body?.export === true) {
        try {
            exported = await exportBusiness(slug);
        } catch (err) {
            return fail(res, err.status || 502, `Export failed, nothing was removed: ${err.message}`);
        }
    }

    try {
        const tokensRevoked = await revokeWhere({ company_id: companyId });
        const { data: installs } = await supabase
            .from('nextgent_installs').select('install_id')
            .eq('company_id', companyId).eq('status', 'active');
        for (const row of installs || []) {
            await billingStripe.removeInstallCharge(row.install_id);
        }
        await supabase.from('nextgent_installs')
            .update({ status: 'removed', removed_at: new Date().toISOString() })
            .eq('company_id', companyId).eq('status', 'active');
        await billingStripe.cancelAtPeriodEnd(slug).catch((err) => console.error('[unlink] cancel', err.message));
        await unlinkCompany(companyId);
        // The business's own data stays: a business that leaves is unlinked,
        // not erased, and can be claimed again.
        res.json({
            unlinked: true,
            entitySlug: slug,
            tokensRevoked,
            installsRemoved: (installs || []).length,
            ...(exported ? { exportUrl: exported.url, exportExpiresAt: exported.expiresAt } : {}),
        });
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

/* ── POST /usage ──────────────────────────────────────────────────────── */

// AI spend for one company over one period, as LiteLLM reports it. Paperclip
// holds the LiteLLM master key and sends this; the same period sent again
// replaces the earlier figure and bills only the difference.
router.post('/usage', async (req, res) => {
    const b = req.body || {};
    const companyId = str(b.companyId);
    const start = new Date(b.periodStart);
    const end = new Date(b.periodEnd);
    const spend = Number(b.spendUsd);
    if (!companyId) return fail(res, 400, 'companyId is required.');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return fail(res, 400, 'periodStart and periodEnd must be dates, start before end.');
    if (!Number.isFinite(spend) || spend < 0) return fail(res, 400, 'spendUsd must be a non-negative number.');
    try {
        const slug = await slugForCompany(companyId);
        if (!slug) return fail(res, 409, 'This company is not linked to a business.');
        const out = await billingStripe.recordUsage({
            slug, companyId, source: str(b.source) || 'ai',
            periodStart: start.toISOString(), periodEnd: end.toISOString(), spendUsd: spend,
        });
        res.json({ recorded: true, ...out });
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

/** For part 2's "give to agent" automation step: the install's routine webhook. */
async function routineFor(installId) {
    const { data } = await supabase.from('nextgent_installs')
        .select('routine_webhook_url, routine_webhook_secret, status, entity_slug')
        .eq('install_id', installId).maybeSingle();
    if (!data || data.status !== 'active' || !data.routine_webhook_url) return null;
    return {
        entitySlug: data.entity_slug,
        webhookUrl: data.routine_webhook_url,
        webhookSecret: secretBox.open(data.routine_webhook_secret, ROUTINE_SECRET_PURPOSE),
    };
}

module.exports = router;
module.exports.routineFor = routineFor;
module.exports.entitlementFor = entitlementFor;
module.exports.COMPANY_PERMISSIONS = COMPANY_PERMISSIONS;
