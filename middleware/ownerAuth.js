// Resolve "which business is this?" from a business dashboard session.
//
// Two kinds of sign-in reach these guards:
//
//   a Supabase access token   the business dashboard's own sign-in. Verified
//                             with Supabase, then the account's business is
//                             looked up in entity_owners.
//
//   a Paperclip business token (CONTRACT §1) — a short-lived JWT Paperclip
//                             signs for one company. Verified against
//                             Paperclip's JWKS (lib/paperclipAuth.js), then the
//                             company's business is looked up in company_links.
//
// Either way ownership comes from a table, server-side. The slug is never
// taken from the request: a business asking to act on someone else's slug
// simply is not that business, and there is nothing in the request it could
// send to change the answer. The one exception is an admin — platform_admins
// by Supabase user id, or by paperclip_user_id for a Paperclip instance_admin —
// who must name the business explicitly.

const supabase = require('../db');
const paperclip = require('../lib/paperclipAuth');
const { slugForCompany } = require('../lib/companyLinks');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearer(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** The explicit slug an admin may name. Only ever read for a vouched-for admin. */
function requestedSlug(req) {
    return String(
        req.query?.slug || req.query?.business || req.body?.slug || req.params?.slug || ''
    ).trim();
}

/* ── the Paperclip path ───────────────────────────────────────────────── */

async function isPaperclipAdmin(paperclipUserId) {
    if (!paperclipUserId) return false;
    const { data, error } = await supabase
        .from('platform_admins')
        .select('paperclip_user_id')
        .eq('paperclip_user_id', paperclipUserId)
        .maybeSingle();
    // A missing column (sql/nextgent_link.sql not applied) means no admins yet.
    if (error) return false;
    return !!data;
}

/**
 * Verify a Paperclip token and resolve what it may act on.
 *
 * Resolves to { claims, slug, isAdmin } or throws with err.status.
 */
async function resolvePaperclip(token) {
    const claims = await paperclip.verifyToken(token);
    // role = instance_admin is a claim Paperclip makes; it is honoured only if
    // this database agrees.
    const isAdmin = claims.role === 'instance_admin' ? await isPaperclipAdmin(claims.sub) : false;
    const slug = await slugForCompany(claims.company_id);
    return { claims, slug, isAdmin };
}

function stampPaperclip(req, { claims, isAdmin }) {
    req.authVia = 'paperclip';
    req.paperclip = { userId: claims.sub, companyId: claims.company_id, role: claims.role, isAdmin };
    // Columns like created_by are uuid; a Paperclip id usually is not one.
    req.ownerUserId = UUID_RE.test(claims.sub) ? claims.sub : null;
}

function paperclipFailure(res, err) {
    const status = err?.status || 401;
    return res.status(status).json({ error: err?.message || 'That session is not valid.' });
}

/* ── guards ───────────────────────────────────────────────────────────── */

/**
 * Resolve the account behind the bearer token, and nothing more.
 *
 * Ownership is deliberately not required here. One endpoint needs that
 * distinction — GET /api/business/me, whose job is to report whether the
 * account owns anything at all, and which therefore cannot be behind a guard
 * that answers 403 when it does not. An admin who has not yet picked a
 * business is in the same position: no ownership row, but they still need the
 * business picker to render.
 *
 * Everything else uses ownerRequired below. This one resolves identity; it
 * grants no access to any business's data on its own. For a Paperclip token it
 * also notes the linked business, if any, so /me can report it.
 */
async function sessionRequired(req, res, next) {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Not signed in.' });

    if (paperclip.isPaperclipToken(token)) {
        try {
            const resolved = await resolvePaperclip(token);
            stampPaperclip(req, resolved);
            req.linkedSlug = resolved.slug;
            return next();
        } catch (err) {
            return paperclipFailure(res, err);
        }
    }

    try {
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: 'That session is not valid.' });
        req.authVia = 'supabase';
        req.ownerUserId = data.user.id;
        req.ownerUser = data.user;
        return next();
    } catch {
        return res.status(401).json({ error: 'That session is not valid.' });
    }
}

async function ownerRequired(req, res, next) {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Not signed in.' });

    if (paperclip.isPaperclipToken(token)) {
        let resolved;
        try {
            resolved = await resolvePaperclip(token);
        } catch (err) {
            return paperclipFailure(res, err);
        }
        stampPaperclip(req, resolved);
        const requested = resolved.isAdmin ? requestedSlug(req) : '';
        if (resolved.isAdmin && requested) {
            req.entitySlug = requested;
            req.actingAsAdmin = true;
            return next();
        }
        if (!resolved.slug) return res.status(403).json({ error: 'This company is not linked to a business.' });
        req.entitySlug = resolved.slug;
        req.ownerRole = resolved.claims.role;
        return next();
    }

    let userId;
    try {
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: 'That session is not valid.' });
        userId = data.user.id;
    } catch {
        return res.status(401).json({ error: 'That session is not valid.' });
    }

    const { data: owned, error: ownerError } = await supabase
        .from('entity_owners')
        .select('entity_slug, role')
        .eq('user_id', userId)
        .limit(1);
    if (ownerError) return res.status(500).json({ error: ownerError.message });

    if (!owned?.length) {
        // An admin viewing a business is allowed to act on it. Checked against
        // platform_admins server-side, and the slug still has to be supplied
        // explicitly rather than assumed.
        const { data: admin } = await supabase
            .from('platform_admins')
            .select('user_id')
            .eq('user_id', userId)
            .maybeSingle();

        // Four ways an admin can name the business they mean, all of them
        // explicit: the dashboard's own ?business=<slug>, a plain ?slug=, the
        // body, or the :slug already in the path on the per-section routers
        // (/api/faqs/:slug and its siblings).
        //
        // All four are only honoured for an account platform_admins vouched
        // for above. For everybody else this block is never reached, and the
        // slug comes from entity_owners or the request is refused.
        const requested = requestedSlug(req);
        if (admin && requested) {
            req.authVia = 'supabase';
            req.ownerUserId = userId;
            req.entitySlug = requested;
            req.actingAsAdmin = true;
            return next();
        }
        return res.status(403).json({ error: 'This account is not linked to a business.' });
    }

    req.authVia = 'supabase';
    req.ownerUserId = userId;
    req.entitySlug = owned[0].entity_slug;
    req.ownerRole = owned[0].role;
    return next();
}

/**
 * Paperclip token required; the company does NOT have to be linked yet.
 *
 * Only for the two claim routes, whose whole purpose is to create the link.
 * req.entitySlug is set when the company is already linked, so a claim route
 * can refuse a second business.
 */
async function paperclipRequired(req, res, next) {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Not signed in.' });
    if (!paperclip.isPaperclipToken(token)) {
        return res.status(401).json({ error: 'This needs a Paperclip business token.' });
    }
    try {
        const resolved = await resolvePaperclip(token);
        stampPaperclip(req, resolved);
        req.entitySlug = resolved.slug || null;
        return next();
    } catch (err) {
        return paperclipFailure(res, err);
    }
}

/**
 * The same resolution for callers that are not Express middleware (the MCP
 * server's session path). No admin slug: there is no request to name one in.
 *
 * Resolves to { slug, userId, via } or { reason }.
 */
async function resolveSessionSlug(token) {
    if (!token) return { reason: 'No bearer token.' };
    if (paperclip.isPaperclipToken(token)) {
        try {
            const { claims, slug } = await resolvePaperclip(token);
            if (!slug) return { reason: 'This company is not linked to a business.' };
            return { slug, userId: claims.sub, via: 'paperclip' };
        } catch (err) {
            return { reason: err.message || 'That token is not valid.' };
        }
    }

    let userId;
    try {
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data?.user) return { reason: 'That token is not valid.' };
        userId = data.user.id;
    } catch {
        return { reason: 'That token is not valid.' };
    }
    const { data: owned } = await supabase
        .from('entity_owners')
        .select('entity_slug')
        .eq('user_id', userId)
        .limit(1);
    if (!owned?.length) return { reason: 'This account is not linked to a business.' };
    return { slug: owned[0].entity_slug, userId, via: 'session' };
}

module.exports = { ownerRequired, sessionRequired, paperclipRequired, resolveSessionSlug, isPaperclipAdmin };
