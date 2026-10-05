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
//   POST   /installs               an agent, app, automation or layout was
//                                  installed (an automation goes onto the
//                                  business through lib/automationInstalls.js,
//                                  the path admin rollouts use too, and gets a
//                                  token like an agent, DECISIONS #87; a layout
//                                  is only an entity_modules row, DECISIONS #31)
//   PATCH  /installs/:installId    an app's or layout's enabled switch, version
//                                  or manifest changed (re-projected into
//                                  entity_modules)
//   DELETE /installs/:installId    …and removed (the projection is switched off
//                                  and kept, the app's records stay)
//   POST   /installs/:installId/session  a short-lived token for that install
//                                  (≤ 300 s, the install's permissions)
//   GET    /entitlement            may this company have this item, and at what price
//   GET    /business-kinds         linked companies grouped by their business's
//                                  kind (entity.entity_type), for the store's
//                                  "by kind" audience (DECISIONS #32): the kind
//                                  lives here, Paperclip keeps no copy
//   POST   /nodes/pair             approve the code a computer shows: it is
//                                  enrolled as a relay node of the company's
//                                  business (DECISIONS #69); a deviceToken,
//                                  when sent, is handed to the computer with
//                                  its node token (DECISIONS #71); the
//                                  assistant's Ghost MCP token is minted and
//                                  returned once (DECISIONS #74)
//   GET    /nodes?companyId=       the company's computers (relay rows)
//   POST   /nodes/:nodeId/revoke   revoke one computer and its agent credentials
//   POST   /unlink                 the business leaves (export first if asked);
//                                  its computers are revoked (DECISIONS #78)
//   POST   /usage                  AI spend from LiteLLM, per company and period
//                                  (refused while LITELLM_USAGE_PULL is on, the
//                                  default: the pull already bills it)
//   PUT    /items/:itemKey/price   the price Paperclip's store set for an item
//   PUT    /numbers/:phone/registration  where a number's texting registration stands
//   POST   /email                  a platform email from templates/email (e.g. team-invite)
//
// Tokens are returned once, in the response that created them. Only their
// hashes are stored (lib/businessTokens.js).

const express = require('express');
const supabase = require('../db');
const { serviceSigned } = require('../lib/serviceSigning');
const { slugForCompany, linkCompany, unlinkCompany } = require('../lib/companyLinks');
const { mintToken, revokeWhere, mintInstallSession } = require('../lib/businessTokens');
const { RESOURCES, normalizePermissions, scopeForPermissions, checkAppTables } = require('../lib/businessTables');
const { envInt } = require('../lib/env');
const { usagePullOn } = require('../lib/litellmUsage');
const appInstances = require('../lib/appInstances');
const { forwardingAddressFor } = require('../lib/forwardingAddress');
const { findExistingEntity } = require('../lib/find-existing-entity');
const { normalizePhone } = require('../lib/telephony');
const entitlements = require('../lib/entitlements');
const billingStripe = require('../lib/billingStripe');
const secretBox = require('../lib/secretBox');
const { exportBusiness } = require('../lib/exportBusiness');
const phoneAgent = require('../lib/phoneAgent');
const automationInstalls = require('../lib/automationInstalls');
const nodePairing = require('../lib/nodePairing');

const router = express.Router();
router.use(serviceSigned);

const fail = (res, status, error, extra) => res.status(status).json({ error, ...(extra || {}) });
const KINDS = new Set(['agent', 'app', 'automation', 'layout']);
// The kinds that are projected to an entity_modules row (lib/appInstances.js).
const PROJECTED_KINDS = new Set(['app', 'layout']);
// The kinds that act through a token: an agent, an app and an automation
// (Paperclip's step runner acts on the business through the MCP with the
// install's token, under exactly the permissions the install declared —
// messages:send among them when declared; DECISIONS #87). A layout is drawn,
// it never calls anything.
const TOKEN_KINDS = new Set(['agent', 'app', 'automation']);
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

    // The business's kind (its entity type): Paperclip targets store audiences by it.
    const { data: entityRow } = await supabase.from('entity').select('entity_type').eq('slug', slug).maybeSingle();

    res.status(created ? 201 : 200).json({
        entitySlug: slug,
        kind: entityRow?.entity_type || null,
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

/* ── GET /business-kinds ──────────────────────────────────────────────── */

// Every linked company, grouped by its business's entity_type as stored:
// [{ key, count, companyIds }], most companies first. A business with no
// kind is left out; there is nothing to target it by.
router.get('/business-kinds', async (req, res) => {
    const { data: links, error } = await supabase.from('company_links').select('company_id, entity_slug');
    if (error) return fail(res, 500, error.message);
    const slugs = [...new Set((links || []).map((l) => l.entity_slug).filter(Boolean))];
    const { data: entities, error: entityError } = slugs.length
        ? await supabase.from('entity').select('slug, entity_type').in('slug', slugs)
        : { data: [], error: null };
    if (entityError) return fail(res, 500, entityError.message);
    const kindOf = new Map((entities || []).map((e) => [e.slug, str(e.entity_type)]));
    const groups = new Map();
    for (const l of links || []) {
        const key = kindOf.get(l.entity_slug);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key).add(String(l.company_id));
    }
    const out = [...groups].map(([key, ids]) => ({ key, count: ids.size, companyIds: [...ids].sort() }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    res.set('Cache-Control', 'no-store');
    res.json(out);
});

/**
 * The app manifest in a Paperclip body, checked (an object, within
 * APP_MANIFEST_MAX_BYTES, its tables acceptable to lib/businessTables.js), or
 * undefined when none was sent. Throws with err.status.
 */
function manifestFrom(app) {
    if (app === undefined || app === null) return undefined;
    if (typeof app !== 'object' || Array.isArray(app)) throw Object.assign(new Error('app must be the app manifest object.'), { status: 400 });
    if (Buffer.byteLength(JSON.stringify(app)) > envInt('APP_MANIFEST_MAX_BYTES', 262144)) throw Object.assign(new Error('The app manifest is too large.'), { status: 413 });
    const problem = checkAppTables(app);
    if (problem) throw Object.assign(new Error(`app manifest: ${problem}`), { status: 400 });
    return app;
}

/**
 * A layout's manifest (Paperclip's store version payload.layout, DECISIONS
 * #31): kept whole as settings.manifest; the renderer is Step 8, so nothing
 * here reads into it beyond its shape and size.
 */
function layoutFrom(layout) {
    if (layout === undefined || layout === null) return undefined;
    if (typeof layout !== 'object' || Array.isArray(layout)) throw Object.assign(new Error('layout must be the layout manifest object.'), { status: 400 });
    if (Buffer.byteLength(JSON.stringify(layout)) > envInt('APP_MANIFEST_MAX_BYTES', 262144)) throw Object.assign(new Error('The layout manifest is too large.'), { status: 413 });
    return layout;
}

/** The manifest an install of `kind` is projected with: an app's or a layout's. */
function projectedManifest(kind, appManifest, layoutManifest) {
    return kind === 'layout' ? layoutManifest : appManifest;
}

/* ── POST /installs ───────────────────────────────────────────────────── */

router.post('/installs', async (req, res) => {
    const b = req.body || {};
    const companyId = str(b.companyId);
    const installId = str(b.installId);
    const itemKey = str(b.itemKey);
    const kind = str(b.kind);
    if (!companyId || !installId || !itemKey) return fail(res, 400, 'companyId, installId and itemKey are required.');
    if (!KINDS.has(kind)) return fail(res, 400, `kind must be one of ${[...KINDS].join(', ')}.`);

    let permissions;
    try {
        permissions = normalizePermissions(b.permissions || []);
    } catch (err) {
        return fail(res, 400, err.message);
    }

    // What the item's manifest says about itself: capabilities (e.g.
    // telephony, which makes it a Phone Agent) and the agent's instructions,
    // kept for the live call and text handlers. A layout has neither.
    const capabilities = kind !== 'layout' && Array.isArray(b.capabilities) ? b.capabilities.map((c) => str(c)).filter(Boolean).slice(0, 50) : [];
    if (kind !== 'layout' && b.telephony && typeof b.telephony === 'object' && !capabilities.includes('telephony')) capabilities.push('telephony');
    const instructions = kind !== 'layout' && typeof b.instructions === 'string' ? b.instructions.slice(0, 20000) : null;
    // An app's manifest (Paperclip's store version payload.app): what the app
    // engine draws, its own tables and its settings. Kept whole in the runtime
    // projection, an entity_modules row per install (CONTRACT §14,
    // lib/appInstances.js), the one row public pages and /api/app-data read.
    let appManifest;
    let layoutManifest;
    try {
        appManifest = manifestFrom(b.app);
        layoutManifest = layoutFrom(b.layout);
    } catch (err) {
        return fail(res, err.status || 400, err.message);
    }
    const manifest = projectedManifest(kind, appManifest, layoutManifest);
    const manifestFields = {
        ...(capabilities.length ? { capabilities } : {}),
        ...(instructions ? { instructions } : {}),
    };
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return fail(res, 400, 'enabled must be true or false.');

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
        const patch = { permissions, version: b.version ?? existing.version, updated_at: new Date().toISOString(), ...manifestFields };
        if (kind === 'automation' && routine) {
            patch.routine_webhook_url = str(routine.webhookUrl);
            patch.routine_webhook_secret = secretBox.seal(str(routine.webhookSecret), ROUTINE_SECRET_PURPOSE);
        }
        // An automation moves to the version the store now has (same install path as a new one).
        if (kind === 'automation') {
            try {
                await automationInstalls.installFromStore({ itemKey, slug, version: b.version ?? existing.version });
            } catch (err) {
                return fail(res, err.status || 500, err.message);
            }
        }
        const { error } = await supabase.from('nextgent_installs').update(patch).eq('install_id', installId);
        if (error) return fail(res, 500, error.message);
        if (PROJECTED_KINDS.has(kind)) {
            try {
                await appInstances.project({ installId, companyId, slug, itemKey, kind, version: patch.version, manifest, enabled: b.enabled });
            } catch (err) {
                if (!(err.code === 'not_configured' && !manifest)) return fail(res, err.status || 500, err.message);
                console.warn(`[nextgent] ${err.message}`);
            }
        }
        await supabase.from('business_mcp_tokens')
            .update({ permissions, scope: scopeForPermissions(permissions) })
            .eq('install_id', installId).is('revoked_at', null);
        return res.json({ updated: true });
    }

    // An automation install puts that automation on the business: the item key
    // is the automation's key. Checked before anything is charged.
    if (kind === 'automation') {
        try {
            const found = await automationInstalls.automationByKey(itemKey);
            if (!found) return fail(res, 409, `No automation has the key ${itemKey}.`);
            await automationInstalls.versionFor(found, b.version);
        } catch (err) {
            return fail(res, err.status || 500, err.message);
        }
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

    // A Phone Agent gets its own number before the install is recorded, so a
    // number that cannot be bought leaves nothing half-made behind.
    let number = null;
    if (phoneAgent.wantsNumber({ ...b, capabilities }, itemKey)) {
        try {
            number = await phoneAgent.provisionNumber({ slug, companyId, installId, payload: b });
        } catch (err) {
            if (charge.charged) await billingStripe.removeInstallCharge(installId);
            return fail(res, err.status && err.status < 500 ? 502 : (err.status || 502), `Could not get a phone number: ${err.message}`);
        }
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
        ...manifestFields,
    });
    if (insertError) {
        if (charge.charged) await billingStripe.removeInstallCharge(installId);
        if (number) await phoneAgent.releaseForInstall(installId);
        return fail(res, 500, insertError.message);
    }

    let phone;
    if (number) {
        try {
            await phoneAgent.chargeNumber(number, { installCharged: !!charge.charged, itemKey });
        } catch (err) {
            await phoneAgent.releaseForInstall(installId);
            if (charge.charged) await billingStripe.removeInstallCharge(installId);
            await supabase.from('nextgent_installs').update({ status: 'removed', removed_at: new Date().toISOString() }).eq('install_id', installId);
            return fail(res, err.status || 502, `The number could not be billed, so it was released: ${err.message}`);
        }
        phone = {
            number: number.phone_number,
            registrationStatus: number.registration_status,
            forwarding: await phoneAgent.forwardingFor(number.phone_number),
        };
    }

    // An automation install is also the entity_automations row, through the
    // same path an admin rollout uses (the gcr engine keeps running it until
    // Paperclip's runner takes over; its token is minted below like an agent's).
    let automation;
    if (kind === 'automation') {
        try {
            const done = await automationInstalls.installFromStore({ itemKey, slug, version: b.version });
            automation = { key: done.automation.key, version: done.version };
        } catch (err) {
            if (charge.charged) await billingStripe.removeInstallCharge(installId);
            await supabase.from('nextgent_installs').update({ status: 'removed', removed_at: new Date().toISOString() }).eq('install_id', installId);
            return fail(res, err.status || 500, err.message);
        }
    }

    // An app's (or a layout's) runtime projection: manifest, settings, public switches.
    if (PROJECTED_KINDS.has(kind)) {
        try {
            await appInstances.project({ installId, companyId, slug, itemKey, kind, version: b.version != null ? String(b.version) : null, manifest, enabled: b.enabled });
        } catch (err) {
            // No manifest to keep and the table not there yet: the install
            // still stands, as it did before this projection existed.
            if (err.code === 'not_configured' && !manifest) {
                console.warn(`[nextgent] ${err.message}`);
            } else {
                if (charge.charged) await billingStripe.removeInstallCharge(installId);
                await supabase.from('nextgent_installs').update({ status: 'removed', removed_at: new Date().toISOString() }).eq('install_id', installId);
                return fail(res, err.status || 500, err.message);
            }
        }
    }

    // Agents, apps and automations get a token holding only what the owner approved.
    let token;
    if (TOKEN_KINDS.has(kind)) {
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
        ...(phone ? { phone } : {}),
        ...(automation ? { automation } : {}),
        charged: !!charge.charged,
        ...(charge.charged ? { priceCents: charge.priceCents, interval: charge.interval } : {}),
    });
});

/* ── POST /installs/:installId/session ────────────────────────────────── */

// A short-lived token for one install, for the screen that draws it: at most
// 300 s (INSTALL_SESSION_TTL_SECONDS), the install's permissions as they are
// when it is used, dead once the install is removed (lib/businessTokens.js).
// The long-lived install token stays with Paperclip.
router.post('/installs/:installId/session', async (req, res) => {
    const installId = str(req.params.installId);
    const { data, error } = await supabase
        .from('nextgent_installs').select('install_id, company_id, kind, status')
        .eq('install_id', installId).maybeSingle();
    if (error) return fail(res, 503, `Installs are not set up on this database yet: ${error.message}`);
    if (!data) return fail(res, 404, 'No such install.');
    const companyId = str(req.body?.companyId);
    if (companyId && companyId !== data.company_id) return fail(res, 404, 'No such install.');
    if (data.status !== 'active') return fail(res, 409, 'That install was removed.');
    if (!TOKEN_KINDS.has(data.kind)) return fail(res, 409, 'Layout installs have no token.');
    try {
        res.set('Cache-Control', 'no-store');
        res.status(201).json(mintInstallSession({ installId: data.install_id, companyId: data.company_id }));
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

/* ── PATCH /installs/:installId ───────────────────────────────────────── */

// Paperclip switched an install on or off, or moved it to a version (with the
// manifest that version carries: `app` for an app, `layout` for a layout). The
// install row keeps the version; an app's or layout's projection is refreshed
// with whatever was sent (lib/appInstances.project).
router.patch('/installs/:installId', async (req, res) => {
    const installId = str(req.params.installId);
    const b = req.body || {};
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return fail(res, 400, 'enabled must be true or false.');
    if (b.version !== undefined && b.version !== null && !str(b.version)) return fail(res, 400, 'version must be a string.');
    let appManifest;
    let layoutManifest;
    try {
        appManifest = manifestFrom(b.app);
        layoutManifest = layoutFrom(b.layout);
    } catch (err) {
        return fail(res, err.status || 400, err.message);
    }
    const version = b.version !== undefined && b.version !== null ? str(b.version) : undefined;
    if (b.enabled === undefined && version === undefined && appManifest === undefined && layoutManifest === undefined) return fail(res, 400, 'Send enabled, version, app or layout.');

    const { data: existing, error: readError } = await supabase
        .from('nextgent_installs').select('install_id, company_id, entity_slug, item_key, kind, version, status')
        .eq('install_id', installId).maybeSingle();
    if (readError) return fail(res, 503, `Installs are not set up on this database yet: ${readError.message}`);
    if (!existing) return fail(res, 404, 'No such install.');
    if (existing.status !== 'active') return fail(res, 409, 'That install was removed; install again with a new installId.');

    if (version !== undefined && version !== existing.version) {
        const { error } = await supabase.from('nextgent_installs')
            .update({ version, updated_at: new Date().toISOString() }).eq('install_id', installId);
        if (error) return fail(res, 500, error.message);
    }
    let projected = false;
    if (PROJECTED_KINDS.has(existing.kind)) {
        try {
            await appInstances.project({
                installId, companyId: existing.company_id, slug: existing.entity_slug, itemKey: existing.item_key, kind: existing.kind,
                version, manifest: projectedManifest(existing.kind, appManifest, layoutManifest), enabled: b.enabled,
            });
            projected = true;
        } catch (err) {
            return fail(res, err.status || 500, err.message, err.code ? { code: err.code } : undefined);
        }
    }
    res.json({ updated: true, projected });
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
            .select('install_id, kind, item_key, entity_slug');
        const charges = await billingStripe.removeInstallCharge(installId);
        const numbersReleased = await phoneAgent.releaseForInstall(installId);
        // Both surfaces go: the owner's screen (its token) and the public page.
        // The projection row and the app's records stay (DECISIONS #22).
        const appRemoved = await appInstances.remove(installId);
        if (!data?.length && !revoked) return fail(res, 404, 'No such install.');
        const row = data?.[0];
        const automationsDisabled = row?.kind === 'automation'
            ? await automationInstalls.uninstallFromStore({ itemKey: row.item_key, slug: row.entity_slug })
            : 0;
        res.json({ removed: true, tokensRevoked: revoked, chargesRemoved: charges.removed, numbersReleased, automationsDisabled, ...(appRemoved ? { app: appRemoved } : {}) });
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

/* ── computers: /nodes/pair, /nodes, /nodes/:nodeId/revoke ────────────── */

// The relay node rows (ghost_nodes) a company's computers are. The business
// is resolved from company_links; the node rows are then filtered on that
// slug, so a company only ever sees and touches its own.
const NODE_COLUMNS = 'id, name, token_hint, version, health, created_at, last_seen_at, revoked_at';

async function linkedSlug(res, companyId) {
    if (!companyId) { fail(res, 400, 'companyId is required.'); return null; }
    let slug;
    try {
        slug = await slugForCompany(companyId);
    } catch (err) {
        fail(res, 500, err.message);
        return null;
    }
    if (!slug) { fail(res, 409, 'This company is not linked to a business.'); return null; }
    return slug;
}

// Paperclip approved the code the computer shows (its owner typed it there):
// the node is enrolled for the company's business. `deviceToken`, when sent,
// is sealed into the pairing and collected by the computer with its node token.
// The company's assistant gets its Ghost MCP credential for this computer in
// the same answer, once; Paperclip keeps it as a company secret (DECISIONS #74).
router.post('/nodes/pair', async (req, res) => {
    const b = req.body || {};
    const companyId = str(b.companyId);
    const slug = await linkedSlug(res, companyId);
    if (!slug) return;
    try {
        const { node } = await nodePairing.approvePairing({
            entitySlug: slug,
            code: b.code,
            name: str(b.name),
            approvedBy: str(b.approvedBy) || null,
            deviceToken: str(b.deviceToken) || null,
        });
        const { token: ghostMcpToken } = await nodePairing.mintMcpToken({ nodeId: node.id, entitySlug: slug, label: `assistant:${companyId}` });
        res.set('Cache-Control', 'no-store');
        res.status(201).json({
            node: { id: node.id, name: node.name, version: node.version, health: node.health, last_seen_at: node.last_seen_at },
            ghostMcpToken,
        });
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

router.get('/nodes', async (req, res) => {
    const slug = await linkedSlug(res, str(req.query?.companyId));
    if (!slug) return;
    const { data, error } = await supabase.from('ghost_nodes').select(NODE_COLUMNS)
        .eq('entity_slug', slug).order('created_at', { ascending: true });
    if (error) return fail(res, 503, `Ghost nodes are not set up on this database yet: ${error.message}`);
    res.set('Cache-Control', 'no-store');
    res.json({ nodes: data || [] });
});

router.post('/nodes/:nodeId/revoke', async (req, res) => {
    const slug = await linkedSlug(res, str(req.body?.companyId));
    if (!slug) return;
    try {
        const count = await nodePairing.revokeNodes({ entitySlug: slug, nodeId: str(req.params.nodeId) });
        if (!count) return fail(res, 404, 'No such computer.');
        res.json({ revoked: true });
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
            await phoneAgent.releaseForInstall(row.install_id);
            await appInstances.remove(row.install_id);
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

// AI spend for one company over one period, as LiteLLM reports it; the same
// period sent again replaces the earlier figure and bills only the difference.
// The pull (lib/litellmUsage.js) is the path in use, and on by default; while
// it is on this push is refused, so the same spend is never billed twice.
router.post('/usage', async (req, res) => {
    if (usagePullOn()) {
        return fail(res, 409, 'Usage is pulled from LiteLLM here (LITELLM_USAGE_PULL is on); pushed usage is refused so it is not billed twice.', { code: 'usage_pull_on' });
    }
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

/* ── POST /email ──────────────────────────────────────────────────────── */

// A platform email Paperclip asks for (team invites, …): a template from
// templates/email, sent through utils/email.js. companyId, when given, must
// be linked; the business name in the data is Paperclip's to supply.
router.post('/email', async (req, res) => {
    const b = req.body || {};
    try {
        if (b.companyId && !(await slugForCompany(str(b.companyId)))) return fail(res, 409, 'This company is not linked to a business.');
        const out = await require('../lib/emailTemplates').sendTemplate({ to: b.to, template: str(b.template), data: b.data || {} });
        res.status(out.sent ? 200 : 502).json(out);
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

/* ── PUT /numbers/:phone/registration ─────────────────────────────────── */

// The texting registration (A2P 10DLC) is filed outside this API; whoever
// handles it reports where it stands here. Texts from the number are allowed
// only once it is approved (lib/messages.js).
router.put('/numbers/:phone/registration', async (req, res) => {
    try {
        const row = await phoneAgent.setRegistration(req.params.phone, {
            status: str(req.body?.status), ref: str(req.body?.ref) || null, note: str(req.body?.note) || null,
        });
        res.json({ number: row.phone_number, registrationStatus: row.registration_status });
    } catch (err) {
        fail(res, err.status || 500, err.message);
    }
});

/* ── PUT /items/:itemKey/price ────────────────────────────────────────── */

// Paperclip's store sets an item's price here (CONTRACT §12); entitlement and
// install charges read it through billingStripe.itemByKey.
router.put('/items/:itemKey/price', async (req, res) => {
    const itemKey = str(req.params.itemKey);
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(itemKey)) return fail(res, 400, 'Not an item key.');
    const b = req.body || {};
    try {
        const saved = await billingStripe.setItemPrice({
            itemKey, amountCents: b.amountCents, currency: b.currency, interval: b.interval, model: b.model,
        });
        res.json({
            itemKey,
            amountCents: saved.amount_cents,
            currency: saved.currency,
            interval: saved.interval,
            model: saved.model,
            stripePriceId: saved.stripe_price_id,
            ...(saved.amount_cents > 0 && !saved.stripeConfigured ? { warning: 'Stripe is not configured; installs of this item are refused until it is.' } : {}),
        });
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
