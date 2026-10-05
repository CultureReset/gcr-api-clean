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

/**
 * A Paperclip token that is a platform admin's (CONTRACT §12): verified, role
 * instance_admin, and its sub listed in platform_admins.paperclip_user_id.
 * Resolves to the claims, or null when the token is valid but not an admin's.
 * Throws (err.status) when the token itself is not valid.
 */
async function resolvePaperclipAdmin(token) {
    const claims = await paperclip.verifyToken(token);
    if (claims.role !== 'instance_admin') return null;
    return (await isPaperclipAdmin(claims.sub)) ? claims : null;
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

/* ── the one resolver ─────────────────────────────────────────────────── */

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Who is behind this bearer token, and which business they own.
 *
 * The one copy of the resolution every business guard here uses (and that
 * other callers import instead of repeating it):
 *
 *   Paperclip token  verified against Paperclip's JWKS, its company resolved
 *                    through company_links; instance_admin honoured only if
 *                    platform_admins.paperclip_user_id lists the user.
 *   Supabase token   verified with Supabase, the business looked up in
 *                    entity_owners; an account owning none is an admin only
 *                    if platform_admins lists its user id.
 *
 * Resolves to { via, userId, user?, claims?, slug, role, isAdmin }. `slug` is
 * the business the token owns (null when it owns none). Throws an error with
 * err.status (401 not signed in or not valid, 500 the lookup failed).
 */
async function resolveBusinessCaller(token) {
    if (!token) throw httpError(401, 'Not signed in.');

    if (paperclip.isPaperclipToken(token)) {
        let resolved;
        try {
            resolved = await resolvePaperclip(token);
        } catch (err) {
            throw httpError(err?.status || 401, err?.message || 'That session is not valid.');
        }
        const { claims, slug, isAdmin } = resolved;
        return { via: 'paperclip', userId: claims.sub, claims, slug: slug || null, role: claims.role, isAdmin: !!isAdmin };
    }

    let user;
    try {
        const { data, error } = await supabase.auth.getUser(token);
        if (!error && data?.user) user = data.user;
    } catch {
        user = null;
    }
    if (!user) throw httpError(401, 'That session is not valid.');

    const { data: owned, error: ownerError } = await supabase
        .from('entity_owners')
        .select('entity_slug, role')
        .eq('user_id', user.id)
        .limit(1);
    if (ownerError) throw httpError(500, ownerError.message);
    if (owned?.length) {
        return { via: 'supabase', userId: user.id, user, slug: owned[0].entity_slug, role: owned[0].role, isAdmin: false };
    }

    // No business of their own: an admin, if platform_admins vouches for them.
    const { data: admin } = await supabase
        .from('platform_admins')
        .select('user_id')
        .eq('user_id', user.id)
        .maybeSingle();
    return { via: 'supabase', userId: user.id, user, slug: null, role: null, isAdmin: !!admin };
}

const notLinked = (via) => (via === 'paperclip' ? 'This company is not linked to a business.' : 'This account is not linked to a business.');

function stampCaller(req, caller) {
    if (caller.via === 'paperclip') {
        stampPaperclip(req, caller);
    } else {
        req.authVia = 'supabase';
        req.ownerUserId = caller.userId;
    }
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

/**
 * The business is the one the token owns: req.entitySlug. An admin (Paperclip
 * instance_admin or a platform_admins account) names the business explicitly
 * — ?business=, ?slug=, body.slug or the :slug in the path — and only an admin
 * vouched for server-side gets that far.
 */
async function ownerRequired(req, res, next) {
    let caller;
    try {
        caller = await resolveBusinessCaller(bearer(req));
    } catch (err) {
        return res.status(err.status || 401).json({ error: err.message || 'That session is not valid.' });
    }
    stampCaller(req, caller);

    // An owner acts on their own business, whatever they typed.
    if (caller.slug && !(caller.via === 'paperclip' && caller.isAdmin && requestedSlug(req))) {
        req.entitySlug = caller.slug;
        req.ownerRole = caller.role;
        return next();
    }
    const requested = caller.isAdmin ? requestedSlug(req) : '';
    if (caller.isAdmin && requested) {
        req.entitySlug = requested;
        req.actingAsAdmin = true;
        return next();
    }
    return res.status(403).json({ error: notLinked(caller.via), code: 'not_linked' });
}

/**
 * For routers whose callers are a business owner OR the admin console (the
 * email parser's manual entry, bulk import, log and setup). Accepts the admin
 * console's own JWT (middleware/auth.js consoleAdminClaims) as well as
 * everything resolveBusinessCaller accepts, and normalises the answer:
 *
 *   req.scopeSlug   the ONE slug this caller may touch, or null for an admin
 *                   who may touch any.
 *   req.isAdmin     true for an admin of any kind.
 *
 * Then a handler calls assertSlug(); the slug is never trusted from the
 * request for a non-admin.
 */
async function businessOrAdminRequired(req, res, next) {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Sign in to do that.' });

    // Required lazily: auth.js requires this file lazily too.
    const { consoleAdminClaims } = require('./auth');
    const consoleAdmin = consoleAdminClaims(token);
    if (consoleAdmin) {
        req.isAdmin = true;
        req.scopeSlug = null;
        req.userId = consoleAdmin.userId;
        return next();
    }

    let caller;
    try {
        caller = await resolveBusinessCaller(token);
    } catch (err) {
        return res.status(err.status || 401).json({ error: err.message || 'That session is not valid.' });
    }
    stampCaller(req, caller);
    if (caller.isAdmin) {
        req.isAdmin = true;
        req.scopeSlug = null;
        return next();
    }
    if (!caller.slug) return res.status(403).json({ error: notLinked(caller.via), code: 'not_linked' });
    req.scopeSlug = caller.slug;
    req.ownerRole = caller.role;
    return next();
}

/**
 * The slug this request is allowed to act on, or null if it may not.
 *
 * Call AFTER businessOrAdminRequired. An admin gets whatever slug they asked
 * for; an owner gets their own slug and nothing else, whatever they typed.
 */
function scopedSlug(req, requested) {
    const asked = String(requested || '').trim();
    if (req.isAdmin) return asked || null;
    if (!req.scopeSlug) return null;
    if (asked && asked !== req.scopeSlug) return null;
    return req.scopeSlug;
}

/**
 * Resolve the slug or end the request with 403. Returns null when it has
 * already responded:
 *
 *     const slug = assertSlug(req, res, req.body.entity_slug);
 *     if (!slug) return;
 */
function assertSlug(req, res, requested) {
    const slug = scopedSlug(req, requested);
    if (!slug) {
        res.status(403).json({ error: 'Not your business.' });
        return null;
    }
    return slug;
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
    let caller;
    try {
        caller = await resolveBusinessCaller(token);
    } catch (err) {
        if (paperclip.isPaperclipToken(token)) return { reason: err.message || 'That token is not valid.' };
        return { reason: err.status === 401 ? 'That token is not valid.' : (err.message || 'That token is not valid.') };
    }
    if (!caller.slug) return { reason: notLinked(caller.via) };
    return { slug: caller.slug, userId: caller.userId, via: caller.via === 'paperclip' ? 'paperclip' : 'session' };
}

module.exports = {
    ownerRequired,
    sessionRequired,
    paperclipRequired,
    businessOrAdminRequired,
    scopedSlug,
    assertSlug,
    resolveBusinessCaller,
    resolveSessionSlug,
    isPaperclipAdmin,
    resolvePaperclipAdmin,
};
