// Who is allowed to act on ONE business's operational data?
//
// Two kinds of caller legitimately reach these routes and they authenticate
// differently, which is why neither existing guard fits on its own:
//
//   the admin console   Bearer <Express JWT>      middleware/auth.js issues it,
//                       role 'admin'              and it carries no single slug
//                                                 because an admin acts on all.
//   a business owner    Bearer <Supabase token>   middleware/ownerAuth.js
//                                                 resolves it to the one slug
//                                                 entity_owners says they own.
//
// businessAccess accepts either and normalises the answer onto the request:
//
//   req.scopeSlug   the ONE slug this caller may touch, or null for an admin
//                   who may touch any.
//   req.isAdmin     true for the admin JWT path.
//
// Then assertSlug() is the only thing a route has to call. The slug is never
// trusted from the request for a non-admin: it is compared against the slug
// ownership resolved server-side, and a mismatch is a 403 regardless of what
// the body said.

const jwt = require('jsonwebtoken');
const supabase = require('../db');

async function businessAccess(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Sign in to do that.' });
    }
    const token = header.slice(7);

    // Admin JWT first — cheap, synchronous, and the common case for the console.
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.role === 'admin') {
            req.isAdmin = true;
            req.scopeSlug = null;
            req.userId = decoded.userId;
            return next();
        }
    } catch {
        // Not an Express JWT — fall through to the owner session below.
    }

    // Business owner: a Supabase access token resolved through entity_owners.
    let userId;
    try {
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data?.user) {
            return res.status(401).json({ error: 'That session is not valid.' });
        }
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
        // A platform admin signed in through Supabase rather than the console.
        const { data: admin } = await supabase
            .from('platform_admins')
            .select('user_id')
            .eq('user_id', userId)
            .maybeSingle();
        if (admin) {
            req.isAdmin = true;
            req.scopeSlug = null;
            req.ownerUserId = userId;
            return next();
        }
        return res.status(403).json({ error: 'This account is not linked to a business.' });
    }

    req.ownerUserId = userId;
    req.scopeSlug = owned[0].entity_slug;
    req.ownerRole = owned[0].role;
    return next();
}

/**
 * The slug this request is allowed to act on, or null if it may not.
 *
 * Call AFTER businessAccess. An admin gets whatever slug they asked for; an
 * owner gets their own slug and nothing else, whatever they typed.
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
 * already responded, so a route reads:
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

module.exports = { businessAccess, scopedSlug, assertSlug };
