const jwt = require('jsonwebtoken');
const supabase = require('../db');

// Verify JWT and attach site_id to request
// Accepts both Express JWTs (JWT_SECRET) and Supabase JWTs (old + GCR)
function authRequired(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.split(' ')[1];

    // Try Express JWT first
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.siteId = decoded.siteId;
        req.role = decoded.role;
        // Admin-minted view-as token: scopes the request to a specific entity
        // (lib/entity-resolver.js checks this before any ownership lookup).
        // Only POST /api/admin/view-as mints these, so it can't be forged.
        if (decoded.viewAs === true && decoded.viewAsEntitySlug) {
            req.viewAsEntitySlug = decoded.viewAsEntitySlug;
        }
        return next();
    } catch (err) {
        // Not an Express JWT — try Supabase JWT
    }

    // Try old Supabase JWT (Circle Boats)
    supabase.auth.getUser(token).then(async ({ data, error }) => {
        if (!error && data.user) {
            // Look up site_id — first by auth_id (fast path)
            let { data: user } = await supabase
                .from('users')
                .select('id, site_id, role')
                .eq('auth_id', data.user.id)
                .maybeSingle();

            // Fallback: look up by email
            if (!user && data.user.email) {
                const { data: byEmail } = await supabase
                    .from('users')
                    .select('id, site_id, role')
                    .eq('email', data.user.email)
                    .maybeSingle();
                if (byEmail) {
                    user = byEmail;
                    await supabase.from('users').update({ auth_id: data.user.id }).eq('id', byEmail.id);
                }
            }

            if (user) {
                req.userId = data.user.id;
                req.siteId = user.site_id;
                req.role = user.role || 'owner';
                return next();
            }
        }

        // Try GCR Supabase JWT
        try {
            const { data: gcrData, error: gcrError } = await supabase.auth.getUser(token);
            if (gcrError || !gcrData.user) {
                return res.status(401).json({ error: 'Invalid token' });
            }
            req.gcrUserId = gcrData.user.id;
            req.isGCR = true;
            req.role = 'owner';
            return next();
        } catch (e) {
            return res.status(401).json({ error: 'Invalid token' });
        }
    }).catch(() => res.status(401).json({ error: 'Invalid token' }));
}

// Admin only (your account)
function adminRequired(req, res, next) {
    authRequired(req, res, () => {
        if (req.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
}

module.exports = { authRequired, adminRequired };
