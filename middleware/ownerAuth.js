// Resolve "which business is this?" from a business dashboard session.
//
// The business dashboard signs in through Supabase Auth, so the bearer token
// is a Supabase access token — not the JWT that middleware/auth.js issues for
// admins. This verifies that token and looks up which entity the account owns.
//
// Ownership comes from entity_owners, server-side. The slug is never taken
// from the request: a business asking to act on someone else's slug simply is
// not that business, and there is nothing in the request it could send to
// change the answer.

const supabase = require('../db');

/**
 * Resolve the account behind the bearer token, and nothing more.
 *
 * Ownership is deliberately not consulted here. One endpoint needs that
 * distinction — GET /api/business/me, whose job is to report whether the
 * account owns anything at all, and which therefore cannot be behind a guard
 * that answers 403 when it does not. An admin who has not yet picked a
 * business is in the same position: no ownership row, but they still need the
 * business picker to render.
 *
 * Everything else uses ownerRequired below. This one resolves identity; it
 * grants no access to any business's data on its own.
 */
async function sessionRequired(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not signed in.' });

    try {
        const { data, error } = await supabase.auth.getUser(header.slice(7));
        if (error || !data?.user) return res.status(401).json({ error: 'That session is not valid.' });
        req.ownerUserId = data.user.id;
        req.ownerUser = data.user;
        return next();
    } catch {
        return res.status(401).json({ error: 'That session is not valid.' });
    }
}

async function ownerRequired(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not signed in.' });

    let userId;
    try {
        const { data, error } = await supabase.auth.getUser(header.slice(7));
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
        const requested = (
            req.query?.slug || req.query?.business || req.body?.slug || req.params?.slug || ''
        ).trim();
        if (admin && requested) {
            req.ownerUserId = userId;
            req.entitySlug = requested;
            req.actingAsAdmin = true;
            return next();
        }
        return res.status(403).json({ error: 'This account is not linked to a business.' });
    }

    req.ownerUserId = userId;
    req.entitySlug = owned[0].entity_slug;
    req.ownerRole = owned[0].role;
    return next();
}

module.exports = { ownerRequired, sessionRequired };
