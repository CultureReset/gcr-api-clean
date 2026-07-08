const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const supabase = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// ============================================
// POST /api/auth/signup — Create account + business
// Creates BOTH a Supabase Auth user (for frontend RLS/login)
// AND a users table record (for backend JWT + site_id linkage)
// Uses service key — bypasses RLS for initial record creation
// ============================================
router.post('/signup', async (req, res) => {
    try {
        const email = req.body.email;
        const password = req.body.password;
        const name = req.body.name || req.body.owner_name || req.body.businessName || req.body.business_name;
        const businessName = req.body.businessName || req.body.business_name;
        const businessType = req.body.businessType || req.body.industry || 'rental';
        const phone = req.body.phone || null;

        if (!email || !password || !businessName) {
            return res.status(400).json({ error: 'Required fields: email, password, businessName' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Check if email already exists in users table
        const { data: existing } = await supabase
            .from('users')
            .select('id')
            .eq('email', email.toLowerCase())
            .single();

        if (existing) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        // Step 1: Create Supabase Auth user (auto-confirmed so they can login immediately)
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
            email: email.toLowerCase(),
            password: password,
            email_confirm: true
        });

        if (authError) {
            if (authError.message && authError.message.includes('already been registered')) {
                return res.status(409).json({ error: 'Email already registered' });
            }
            return res.status(400).json({ error: 'Auth error: ' + authError.message });
        }

        const authId = authData.user.id;

        // Step 2: Generate a unique slug from the business name — this is
        // CyberCheck's own account (businesses/users tables), separate from
        // Gulf Coast Radar's `entity` table. Signing up here does NOT create
        // a GCR listing — that's a separate, optional claim step. A business
        // can have a CyberCheck dashboard without ever being on GCR.
        const baseSlug = businessName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        const { data: slugExists } = await supabase
            .from('businesses')
            .select('id')
            .eq('slug', baseSlug)
            .maybeSingle();

        const finalSlug = slugExists ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;

        // Step 3: Hash password (kept for backend JWT login fallback)
        const passwordHash = await bcrypt.hash(password, 12);

        // Step 4: Create business record — real schema (id/slug/name/category/
        // phone/is_active), not the legacy site_id/type/subdomain/plan/status
        // shape this used to assume, which doesn't exist on the live table.
        const { data: business, error: bizError } = await supabase
            .from('businesses')
            .insert({
                slug: finalSlug,
                name: businessName,
                category: businessType,
                phone: phone,
                email: email.toLowerCase(),
                is_active: true,
            })
            .select()
            .single();

        if (bizError) {
            await supabase.auth.admin.deleteUser(authId);
            return res.status(500).json({ error: 'Failed to create business: ' + bizError.message });
        }

        // Step 5: Create user record linking Supabase Auth to business.
        // users.site_id stores businesses.id (naming is legacy, value is real).
        const { data: user, error: userError } = await supabase
            .from('users')
            .insert({
                auth_id: authId,
                site_id: business.id,
                email: email.toLowerCase(),
                name: name || businessName,
                password_hash: passwordHash,
                role: 'owner'
            })
            .select()
            .single();

        if (userError) {
            await supabase.from('businesses').delete().eq('id', business.id);
            await supabase.auth.admin.deleteUser(authId);
            return res.status(500).json({ error: 'Failed to create user: ' + userError.message });
        }

        // Step 6: Create empty site_content row — this table's schema was
        // already correct, no fix needed here.
        const contentRow = { site_id: business.id, contact_email: email.toLowerCase() };
        if (phone) contentRow.contact_phone = phone;
        await supabase.from('site_content').insert(contentRow);

        // Step 7: Generate JWT (for backend API usage)
        const token = jwt.sign(
            { userId: user.id, siteId: business.id, role: 'owner' },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.status(201).json({
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
            business: {
                site_id: business.id,
                slug: business.slug,
                name: business.name,
                type: business.category
            }
        });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Signup failed: ' + err.message });
    }
});

// ============================================
// GET /api/auth/invite/:token — preview an invite (claim page loads this
// to show "You're setting up ENTITY_NAME's account")
// ============================================
router.get('/invite/:token', async (req, res) => {
    try {
        const { data: invite } = await supabase
            .from('business_invites')
            .select('email, status, expires_at, entity_slug, entity:entity_slug(name, icon)')
            .eq('token', req.params.token)
            .maybeSingle();

        if (!invite) return res.status(404).json({ error: 'This invite link is invalid.' });
        if (invite.status !== 'pending') return res.status(409).json({ error: 'This invite has already been used.' });
        if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'This invite link has expired.' });

        res.json({
            email: invite.email,
            entity_slug: invite.entity_slug,
            business_name: invite.entity ? invite.entity.name : invite.entity_slug,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// POST /api/auth/accept-invite — { token, password } → real Supabase Auth
// account (not a hand-inserted one), linked to the invited entity.
// ============================================
router.post('/accept-invite', async (req, res) => {
    try {
        const { token, password } = req.body || {};
        if (!token || !password) return res.status(400).json({ error: 'token and password required' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

        const { data: invite } = await supabase
            .from('business_invites')
            .select('id, email, entity_slug, status, expires_at')
            .eq('token', token)
            .maybeSingle();

        if (!invite) return res.status(404).json({ error: 'This invite link is invalid.' });
        if (invite.status !== 'pending') return res.status(409).json({ error: 'This invite has already been used.' });
        if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'This invite link has expired.' });

        const { data: entity } = await supabase.from('entity').select('id, slug, name, phone, city').eq('slug', invite.entity_slug).maybeSingle();
        if (!entity) return res.status(404).json({ error: 'The business for this invite no longer exists.' });

        const { data: existingUser } = await supabase.from('users').select('id').eq('email', invite.email).maybeSingle();
        if (existingUser) return res.status(409).json({ error: 'An account already exists for this email — log in instead.' });

        // Real Supabase Auth account — the correct path, not a hand-inserted password_hash
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
            email: invite.email,
            password,
            email_confirm: true,
        });
        if (authError) return res.status(400).json({ error: 'Account creation failed: ' + authError.message });

        // businesses row — real schema (id/slug/name/category/is_active), not the
        // legacy site_id/type/status/domain/subdomain/plan shape /signup assumes
        const { data: business, error: bizError } = await supabase
            .from('businesses')
            .insert({ slug: entity.slug, name: entity.name, category: 'service', phone: entity.phone || null, city: entity.city || null, is_active: true })
            .select('id')
            .single();
        if (bizError) {
            await supabase.auth.admin.deleteUser(authData.user.id);
            return res.status(500).json({ error: 'Failed to create business record: ' + bizError.message });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const { data: user, error: userError } = await supabase
            .from('users')
            .insert({
                auth_id: authData.user.id,
                site_id: business.id,
                email: invite.email,
                name: entity.name,
                password_hash: passwordHash,
                role: 'owner',
                entity_slug: entity.slug,
                entity_id: entity.id,
            })
            .select()
            .single();
        if (userError) {
            await supabase.from('businesses').delete().eq('id', business.id);
            await supabase.auth.admin.deleteUser(authData.user.id);
            return res.status(500).json({ error: 'Failed to create user record: ' + userError.message });
        }

        await supabase.from('business_invites').update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq('id', invite.id);

        const jwtToken = jwt.sign({ userId: user.id, siteId: business.id, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({
            token: jwtToken,
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
            business: { site_id: business.id, slug: entity.slug, name: entity.name },
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to accept invite: ' + err.message });
    }
});

// ============================================
// POST /api/auth/login
// ============================================
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const { data: user, error } = await supabase
            .from('users')
            .select('id, site_id, email, password_hash, name, role')
            .eq('email', email.toLowerCase())
            .single();

        if (error || !user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Admin users don't have a business — skip business check
        // (fixed: this used to select site_id/type/status/domain/subdomain/plan,
        // none of which exist on the real `businesses` table — every non-admin
        // login 500'd before reaching the token step)
        let business = null;
        if (user.role !== 'admin') {
            const { data: biz } = await supabase
                .from('businesses')
                .select('id, slug, name, category, is_active')
                .eq('id', user.site_id)
                .single();

            if (!biz || !biz.is_active) {
                return res.status(403).json({ error: 'Account is suspended' });
            }
            business = biz;
        }

        const token = jwt.sign(
            { userId: user.id, siteId: user.site_id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
            business: business ? {
                site_id: business.id,
                slug: business.slug,
                name: business.name,
                type: business.category
            } : null
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed: ' + err.message });
    }
});

// ============================================
// POST /api/auth/logout — Invalidate session
// ============================================
router.post('/logout', (req, res) => {
    res.json({ success: true });
});

// ============================================
// POST /api/auth/refresh — Refresh JWT token
// ============================================
router.post('/refresh', authRequired, async (req, res) => {
    const token = jwt.sign(
        { userId: req.userId, siteId: req.siteId, role: req.role },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
    res.json({ token });
});

// ============================================
// GET /api/auth/session — Validate current session
// ============================================
router.get('/session', authRequired, async (req, res) => {
    const { data: user } = await supabase
        .from('users')
        .select('id, name, email, role, avatar_url')
        .eq('id', req.userId)
        .single();

    const { data: business } = await supabase
        .from('businesses')
        .select('site_id, name, type, status, domain, subdomain, plan, logo_url')
        .eq('site_id', req.siteId)
        .single();

    if (!user || !business) {
        return res.status(401).json({ error: 'Session invalid' });
    }

    const { data: apps } = await supabase
        .from('site_apps')
        .select('app_id, enabled, apps(name, icon, category)')
        .eq('site_id', req.siteId)
        .eq('enabled', true);

    res.json({ user, business, apps: apps || [] });
});

// ============================================
// GET /api/auth/verify — Quick token check
// ============================================
router.get('/verify', authRequired, async (req, res) => {
    const { data: user } = await supabase
        .from('users')
        .select('id, name, email, role')
        .eq('id', req.userId)
        .single();

    if (!user) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    res.json({ valid: true, user });
});

// ============================================
// POST /api/auth/forgot-password — Send reset email
// ============================================
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }

    const { data: user } = await supabase
        .from('users')
        .select('id, email, name')
        .eq('email', email.toLowerCase())
        .single();

    if (!user) {
        return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 3600000).toISOString();

    await supabase
        .from('users')
        .update({ reset_token: resetToken, reset_expires: resetExpires })
        .eq('id', user.id);

    res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
});

// ============================================
// POST /api/auth/reset-password — Set new password
// ============================================
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;

    if (!token || !password) {
        return res.status(400).json({ error: 'Token and new password required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const { data: user } = await supabase
        .from('users')
        .select('id, auth_id, reset_token, reset_expires')
        .eq('reset_token', token)
        .single();

    if (!user) {
        return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    if (new Date(user.reset_expires) < new Date()) {
        return res.status(400).json({ error: 'Reset token has expired' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Update password in users table
    await supabase
        .from('users')
        .update({
            password_hash: passwordHash,
            reset_token: null,
            reset_expires: null
        })
        .eq('id', user.id);

    // Also update password in Supabase Auth if auth_id exists
    if (user.auth_id) {
        await supabase.auth.admin.updateUserById(user.auth_id, { password });
    }

    res.json({ success: true, message: 'Password has been reset. You can now log in.' });
});

// ============================================
// POST /api/auth/create-profile — Google OAuth new users
// Supabase already created the auth user. This creates the
// businesses + users records so they have a site_id.
// ============================================
router.post('/create-profile', async (req, res) => {
    try {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }
        const token = header.split(' ')[1];

        const { data: authData, error: authError } = await supabase.auth.getUser(token);
        if (authError || !authData.user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const authId = authData.user.id;
        const email = authData.user.email;
        const { businessName, businessType } = req.body;

        if (!businessName) {
            return res.status(400).json({ error: 'Business name is required' });
        }

        // If user record already exists, just return a JWT
        const { data: existingUser } = await supabase
            .from('users')
            .select('id, site_id, role')
            .eq('auth_id', authId)
            .maybeSingle();

        if (existingUser) {
            const { data: biz } = await supabase
                .from('businesses')
                .select('site_id, name, type, subdomain, plan')
                .eq('site_id', existingUser.site_id)
                .single();
            const token = jwt.sign(
                { userId: existingUser.id, siteId: existingUser.site_id, role: existingUser.role },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );
            return res.json({ token, user: existingUser, business: biz });
        }

        // New user — create business + user records
        const subdomain = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const { data: subExists } = await supabase.from('businesses').select('site_id').eq('subdomain', subdomain).single();
        const finalSubdomain = subExists ? `${subdomain}-${Date.now().toString(36)}` : subdomain;

        const { data: business, error: bizError } = await supabase
            .from('businesses')
            .insert({ name: businessName, type: businessType || 'service', subdomain: finalSubdomain, plan: 'free', status: 'active' })
            .select().single();

        if (bizError) return res.status(500).json({ error: 'Failed to create business: ' + bizError.message });

        const googleName = (authData.user.user_metadata && (authData.user.user_metadata.full_name || authData.user.user_metadata.name)) || businessName;

        const { data: user, error: userError } = await supabase
            .from('users')
            .insert({ auth_id: authId, site_id: business.site_id, email: email.toLowerCase(), name: googleName, role: 'owner' })
            .select().single();

        if (userError) {
            await supabase.from('businesses').delete().eq('site_id', business.site_id);
            return res.status(500).json({ error: 'Failed to create user: ' + userError.message });
        }

        await supabase.from('site_content').insert({ site_id: business.site_id, contact_email: email.toLowerCase() });

        const newToken = jwt.sign(
            { userId: user.id, siteId: business.site_id, role: 'owner' },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.status(201).json({
            token: newToken,
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
            business: { site_id: business.site_id, name: business.name, type: business.type, subdomain: business.subdomain }
        });
    } catch (err) {
        console.error('Create profile error:', err);
        res.status(500).json({ error: 'Failed to create profile: ' + err.message });
    }
});

module.exports = router;
