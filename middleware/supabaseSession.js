// Verify a Supabase Auth access token (password, phone, or OAuth: Google /
// GitHub) and answer "is this account a platform admin?".
//
// Used by the admin guards (routes/admin.js authRequired, middleware/auth.js
// adminRequired) so the admin dashboard can sign in with OAuth and send the
// Supabase JWT as its bearer token, exactly like the business dashboard does.
//
// Verification is done by Supabase itself (auth.getUser), so it works with
// both legacy HS256 and the newer asymmetric signing keys, and a revoked or
// signed-out session is rejected. Results are cached for a few seconds per
// token to avoid one auth round trip per API call.

const db = require('../db');

const CACHE_MS = Number(process.env.SUPABASE_SESSION_CACHE_MS || 30000);
const cache = new Map(); // token -> { at, user }

/** Resolve the Supabase user behind a bearer token, or null. */
async function verifySupabaseToken(token) {
    if (!token || token.split('.').length !== 3) return null;
    const hit = cache.get(token);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
    try {
        const { data, error } = await db.auth.getUser(token);
        const user = !error && data?.user ? data.user : null;
        if (cache.size > 500) cache.clear();
        cache.set(token, { at: Date.now(), user });
        return user;
    } catch {
        return null;
    }
}

/**
 * True when this Supabase user may use the admin dashboard.
 *   1. a row in platform_admins (user_id) — the same table ownerRequired trusts
 *   2. or a verified email that matches admin_users with role 'admin', so an
 *      existing password admin can switch to Google/GitHub without SQL
 * OAUTH_ADMIN_EMAILS (comma separated) can further restrict who qualifies.
 */
async function isPlatformAdmin(user) {
    if (!user?.id) return false;
    const email = String(user.email || '').toLowerCase();
    const allow = (process.env.OAUTH_ADMIN_EMAILS || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.includes(email)) return false;

    const { data: row } = await db
        .from('platform_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    if (row) return true;

    const emailVerified = !!(user.email_confirmed_at || user.confirmed_at);
    if (email && emailVerified) {
        const { data: admin } = await db
            .from('admin_users').select('id, role').eq('email', email).maybeSingle();
        if (admin && admin.role === 'admin') return true;
    }
    return false;
}

/** Admin claims from a Supabase token, or null when it is not an admin session. */
async function supabaseAdminFromToken(token) {
    const user = await verifySupabaseToken(token);
    if (!user || !(await isPlatformAdmin(user))) return { user, admin: null };
    return {
        user,
        admin: { id: user.id, email: user.email, role: 'admin', provider: user.app_metadata?.provider || 'supabase' },
    };
}

module.exports = { verifySupabaseToken, isPlatformAdmin, supabaseAdminFromToken };
