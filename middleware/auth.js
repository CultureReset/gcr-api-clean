const jwt = require('jsonwebtoken');
const supabase = require('../db');
const paperclip = require('../lib/paperclipAuth');

/**
 * A Paperclip instance-admin token (CONTRACT §12). Honoured only when its sub
 * is in platform_admins.paperclip_user_id (middleware/ownerAuth.js, one copy
 * of that check). Any other Paperclip token is refused here: these gates are
 * site_id- and admin-based, and a company token carries neither.
 *
 * Calls next() with req.role = 'admin', or answers 401/403/503 itself.
 */
async function paperclipAdminGate(token, req, res, next) {
    // Required lazily: ownerAuth requires db, and so does this file.
    const { resolvePaperclipAdmin } = require('./ownerAuth');
    let claims;
    try {
        claims = await resolvePaperclipAdmin(token);
    } catch (err) {
        return res.status(err.status || 401).json({ error: err.message || 'Invalid token' });
    }
    if (!claims) return res.status(403).json({ error: 'Admin access required' });
    req.authVia = 'paperclip';
    req.userId = claims.sub;
    req.role = 'admin';
    req.paperclip = { userId: claims.sub, companyId: claims.company_id || null, role: claims.role, isAdmin: true };
    return next();
}

// Verify JWT and attach site_id to request
// Accepts both Express JWTs (JWT_SECRET) and Supabase JWTs (old + GCR)
function authRequired(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.split(' ')[1];

    // A Paperclip token: only an instance admin's is accepted on these gates.
    if (paperclip.isPaperclipToken(token)) return paperclipAdminGate(token, req, res, next);

    // Try Express JWT first
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        req.siteId = decoded.siteId;
        req.role = decoded.role;
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

module.exports = { authRequired, adminRequired, paperclipAdminGate };
