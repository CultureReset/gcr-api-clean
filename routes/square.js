const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const supabase = require('../db');
const { authRequired } = require('../middleware/auth');
// Square SDK removed — using direct REST API calls to avoid Vercel serverless issues

// ─── Reuse encryption from stripe.js ─────────────────────────────────────────
function encryptKey(plaintext) {
    const hexKey = process.env.STRIPE_KEY_ENCRYPTION_KEY;
    if (!hexKey) throw new Error('STRIPE_KEY_ENCRYPTION_KEY not set in environment');
    const key = Buffer.from(hexKey, 'hex');
    const iv  = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decryptKey(stored) {
    const hexKey = process.env.STRIPE_KEY_ENCRYPTION_KEY;
    if (!hexKey) throw new Error('STRIPE_KEY_ENCRYPTION_KEY not set in environment');
    const [ivHex, tagHex, encHex] = stored.split(':');
    const key    = Buffer.from(hexKey, 'hex');
    const iv     = Buffer.from(ivHex, 'hex');
    const tag    = Buffer.from(tagHex, 'hex');
    const encBuf = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encBuf), decipher.final()]).toString('utf8');
}

// Get Square client for a site
async function getSquareForSite(siteId) {
    if (!siteId) return null;
    const [{ data: keyData }, { data: modeData }, { data: appData }, { data: locData }] = await Promise.all([
        supabase.from('connections').select('access_token').eq('site_id', siteId).eq('provider', 'square_key').eq('status', 'connected').single(),
        supabase.from('connections').select('account_name').eq('site_id', siteId).eq('provider', 'square_mode').single(),
        supabase.from('connections').select('account_name').eq('site_id', siteId).eq('provider', 'square_app_id').single(),
        supabase.from('connections').select('account_name').eq('site_id', siteId).eq('provider', 'square_location_id').single()
    ]);

    if (!keyData?.access_token) return null;

    const mode = modeData?.account_name || 'production';
    const accessToken = decryptKey(keyData.access_token);
    const baseUrl = mode === 'sandbox'
        ? 'https://connect.squareupsandbox.com'
        : 'https://connect.squareup.com';
    return {
        accessToken,
        baseUrl,
        locationId: locData?.account_name || null,
        appId: appData?.account_name || null,
        mode
    };
}

// ============================================
// POST /api/square/save-credentials (authRequired)
// Save Square access token + app ID + location ID
// ============================================
router.post('/save-credentials', authRequired, async (req, res) => {
    const { access_token, app_id, location_id, mode } = req.body;

    if (!access_token) return res.status(400).json({ error: 'access_token is required' });
    if (!app_id)       return res.status(400).json({ error: 'app_id is required' });
    if (!location_id)  return res.status(400).json({ error: 'location_id is required' });
    if (!process.env.STRIPE_KEY_ENCRYPTION_KEY) {
        return res.status(503).json({ error: 'Encryption key not configured' });
    }

    try {
        // Verify the access token works via direct REST
        const verifyUrl = mode === 'sandbox'
            ? 'https://connect.squareupsandbox.com/v2/locations'
            : 'https://connect.squareup.com/v2/locations';
        const verifyRes = await fetch(verifyUrl, {
            headers: { 'Authorization': 'Bearer ' + access_token, 'Square-Version': '2024-01-18' }
        });
        if (!verifyRes.ok) throw new Error('Invalid Square access token');

        const encrypted = encryptKey(access_token);
        const now = new Date().toISOString();

        await Promise.all([
            supabase.from('connections').upsert({ site_id: req.siteId, provider: 'square_key', access_token: encrypted, account_name: 'Square Key', status: 'connected', connected_at: now, updated_at: now }, { onConflict: 'site_id,provider' }),
            supabase.from('connections').upsert({ site_id: req.siteId, provider: 'square_app_id', account_name: app_id, status: 'connected', updated_at: now }, { onConflict: 'site_id,provider' }),
            supabase.from('connections').upsert({ site_id: req.siteId, provider: 'square_location_id', account_name: location_id, status: 'connected', updated_at: now }, { onConflict: 'site_id,provider' }),
            supabase.from('connections').upsert({ site_id: req.siteId, provider: 'square_mode', account_name: mode || 'production', status: 'connected', updated_at: now }, { onConflict: 'site_id,provider' })
        ]);

        res.json({ success: true, mode: mode || 'production' });
    } catch (err) {
        console.error('square save-credentials error:', err);
        if (err.message && err.message.includes('UNAUTHORIZED')) {
            return res.status(400).json({ error: 'Invalid Square access token' });
        }
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// GET /api/square/status (authRequired)
// Return Square connection status for dashboard
// ============================================
router.get('/status', authRequired, async (req, res) => {
    const [{ data: keyData }, { data: modeData }, { data: appData }, { data: locData }, { data: procData }] = await Promise.all([
        supabase.from('connections').select('status, connected_at, account_name').eq('site_id', req.siteId).eq('provider', 'square_key').maybeSingle(),
        supabase.from('connections').select('account_name').eq('site_id', req.siteId).eq('provider', 'square_mode').maybeSingle(),
        supabase.from('connections').select('account_name').eq('site_id', req.siteId).eq('provider', 'square_app_id').maybeSingle(),
        supabase.from('connections').select('account_name').eq('site_id', req.siteId).eq('provider', 'square_location_id').maybeSingle(),
        supabase.from('connections').select('account_name').eq('site_id', req.siteId).eq('provider', 'payment_processor').maybeSingle()
    ]);

    res.json({
        connected: !!(keyData && keyData.status === 'connected'),
        connectedAt: keyData?.connected_at || null,
        merchantName: keyData?.account_name || null,
        mode: modeData?.account_name || 'production',
        appId: appData?.account_name || null,
        locationId: locData?.account_name || null,
        activeProcessor: procData?.account_name || 'stripe'
    });
});

// ============================================
// POST /api/square/set-processor (authRequired)
// Set active payment processor for a site
// ============================================
router.post('/set-processor', authRequired, async (req, res) => {
    const { processor } = req.body;
    if (!['stripe', 'square'].includes(processor)) {
        return res.status(400).json({ error: 'processor must be stripe or square' });
    }
    try {
        const now = new Date().toISOString();
        await supabase.from('connections').upsert(
            { site_id: req.siteId, provider: 'payment_processor', account_name: processor, status: 'connected', updated_at: now },
            { onConflict: 'site_id,provider' }
        );
        res.json({ success: true, processor });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// DELETE /api/square/disconnect (authRequired)
// Remove Square credentials
// ============================================
router.delete('/disconnect', authRequired, async (req, res) => {
    try {
        await supabase.from('connections').delete().eq('site_id', req.siteId).in('provider', ['square_key', 'square_app_id', 'square_location_id', 'square_mode', 'square_merchant_id']);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// POST /api/square/create-payment (public)
// Process a Square payment for a booking
// ============================================
router.post('/create-payment', async (req, res) => {
  try {
    const { source_id, amount, booking_id, site_id, description } = req.body;

    if (!source_id) return res.status(400).json({ error: 'source_id required' });
    if (!amount)    return res.status(400).json({ error: 'amount required' });

    // Resolve site_id
    let targetSiteId = req.siteId || null;
    if (site_id) {
        if (/^[0-9a-f-]{36}$/.test(site_id)) {
            targetSiteId = site_id;
        } else {
            const { data: biz } = await supabase.from('businesses').select('site_id').eq('subdomain', site_id).single();
            targetSiteId = biz?.site_id || null;
        }
    }

    const squareData = await getSquareForSite(targetSiteId);
    if (!squareData) {
        return res.status(503).json({ error: 'Square not configured — add Square credentials in Dashboard → Connections' });
    }

    // Amount already includes all fees (service fee + processing fee) calculated on the frontend
    const amountCents = Math.round(parseFloat(amount) * 100);
    const totalCents = amountCents;

    try {
        const idempotencyKey = crypto.randomUUID();
        const payRes = await fetch(`${squareData.baseUrl}/v2/payments`, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + squareData.accessToken,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18'
            },
            body: JSON.stringify({
                source_id,
                idempotency_key: idempotencyKey,
                amount_money: { amount: totalCents, currency: 'USD' },
                location_id: squareData.locationId,
                note: description || 'Booking payment',
                reference_id: booking_id || undefined
            })
        });
        const payData = await payRes.json();
        if (!payRes.ok || !payData.payment) {
            const msg = payData.errors?.[0]?.detail || payData.errors?.[0]?.code || 'Payment failed';
            return res.status(400).json({ success: false, error: msg });
        }
        const payment = payData.payment;

        // Update booking
        if (booking_id) {
            const { error: bookingUpdateErr } = await supabase.from('bookings').update({
                payment_id: payment.id,
                payment_provider: 'square',
                payment_status: payment.status === 'COMPLETED' ? 'paid' : 'pending',
                receipt_number: payment.receipt_number || null,
                receipt_url: payment.receipt_url || null,
                site_id: targetSiteId || null
            }).eq('id', booking_id);
            if (bookingUpdateErr) console.error('Failed to mark booking paid:', booking_id, bookingUpdateErr.message);
        }

        // Fire emails/SMS after payment (same pattern as Stripe)
        if (payment.status === 'COMPLETED' && booking_id && targetSiteId) {
            setImmediate(async () => {
                try {
                    const { sendSms, fillTemplate, buildTemplateData } = require('../utils/sms');
                    const { sendEmail, customerConfirmationHtml, generateIcsContent } = require('../utils/email');
                    const [{ data: bookingData }, { data: business }] = await Promise.all([
                        supabase.from('bookings').select('*').eq('id', booking_id).single(),
                        supabase.from('businesses').select('name, phone').eq('site_id', targetSiteId).single()
                    ]);
                    if (!bookingData) return;
                    // No messaging_settings table exists -- always defaults on, same as stripe.js.
                    const msgSettings = {};
                    const templateData = await buildTemplateData(bookingData, targetSiteId);
                    const customerPhone = bookingData.customer_phone || bookingData.phone;
                    const customerEmail = bookingData.customer_email || bookingData.email;

                    // Waivers aren't linked to individual bookings in the current schema
                    // (waivers is keyed by entity_slug + customer identity, no booking_id,
                    // no site_id) -- best-effort match, never insert a blank placeholder row.
                    try {
                        if (bookingData.entity_slug) {
                            const [{ data: waiverRecord }, { data: biz }] = await Promise.all([
                                supabase.from('waivers').select('token').eq('entity_slug', bookingData.entity_slug).is('signed_at', null).order('created_at', { ascending: false }).maybeSingle(),
                                supabase.from('businesses').select('subdomain, custom_domain').eq('site_id', targetSiteId).maybeSingle()
                            ]);
                            if (waiverRecord?.token && biz) {
                                const domain = biz.custom_domain
                                    || (biz.subdomain ? `https://${biz.subdomain}.cybercheck.com` : 'https://circle-boats-main.vercel.app');
                                templateData.waiver_url = `${((process.env.PUBLIC_SITE_BASE_URL || domain).trim())}/waiver-form.html?token=${waiverRecord.token}`;
                            }
                        }
                    } catch (waiverErr) {
                        console.warn('Waiver fetch failed (continuing with email):', waiverErr.message);
                    }

                    if (customerEmail) {
                        const ics = [{ filename: 'booking.ics', content: Buffer.from(generateIcsContent(templateData)).toString('base64') }];
                        const emailResult = await sendEmail({ to: customerEmail, subject: 'Booking Confirmed — ' + (templateData.business_name || 'Your Reservation'), html: customerConfirmationHtml(templateData), attachments: ics });
                        if (emailResult.success) {
                            console.log('Customer confirmation email sent to:', customerEmail);
                        } else {
                            console.error('Customer email failed:', customerEmail, emailResult.reason);
                        }
                    } else {
                        console.warn('No customer email on booking:', booking_id);
                    }

                    // Customer SMS — this is a transactional receipt for a booking the
                    // customer just made with their own number, not marketing; there is
                    // no sms_consent column/capture step in this flow (that's tracked
                    // separately as a compliance task), so gate on phone presence only,
                    // matching stripe.js's existing behavior for the same notification.
                    if (customerPhone && msgSettings.notify_customer_on_booking !== false) {
                        const defaultCustTpl = '[{{business_name}}] Hi {{customer_name}}! Your booking is confirmed.\n\nDate: {{date}}\nTime: {{time_slot}}\nTotal: ${{total}}\n\nReply STOP to opt out. Msg/data rates may apply.';
                        const custMsg = fillTemplate(msgSettings.customer_booking_template || defaultCustTpl, templateData);
                        sendSms(customerPhone, custMsg, targetSiteId, 'booking_confirmation', booking_id)
                            .catch(err => console.error('Customer SMS failed:', err));
                    }

                    // Admin SMS (platform owner) — full details on payment success
                    const adminPhone = process.env.ADMIN_SMS_NUMBER;
                    if (adminPhone) {
                        const bizName = business?.name || templateData.business_name || 'Client';
                        const adminMsg = [
                            `[${bizName}] PAYMENT PAID`,
                            `Ref: ${templateData.confirmation_number}`,
                            ``,
                            `${bookingData.customer_name}`,
                            `Ph: ${customerPhone || 'N/A'}`,
                            `Em: ${customerEmail || 'N/A'}`,
                            ``,
                            `${templateData.date}`,
                            `${templateData.time_slot}`,
                            `${templateData.boat_count}x ${templateData.boat_type}`,
                            `Guests: ${templateData.guest_count}`,
                            `Add-ons: ${templateData.addons}`,
                            ``,
                            `Total: $${templateData.total}`,
                            `Receipt: ${bookingData.receipt_number || 'N/A'}`,
                            templateData.waiver_url ? `Waiver: ${templateData.waiver_url}` : null,
                            ``,
                            `Notes: ${bookingData.notes || 'None'}`
                        ].filter(Boolean).join('\n');
                        sendSms(adminPhone, adminMsg, targetSiteId, 'booking_owner_notify', booking_id)
                            .catch(err => console.error('Admin SMS failed:', err));
                    }
                } catch (e) { console.error('Square post-payment notifications failed:', e.message, e.stack); }
            });
        }

        res.json({
            success: true,
            payment_id: payment.id,
            status: payment.status,
            amount: totalCents
        });
    } catch (err) {
        console.error('Square create-payment error:', err);
        const msg = err.errors?.[0]?.detail || err.message;
        res.status(500).json({ success: false, error: msg });
    }
  } catch (outerErr) {
    console.error('Square create-payment outer error:', outerErr);
    if (!res.headersSent) res.status(500).json({ success: false, error: outerErr.message || 'Server error' });
  }
});

// ============================================
// POST /api/square/refresh-location (authRequired)
// Fetch location ID from Square and save it
// ============================================
router.post('/refresh-location', authRequired, async (req, res) => {
    try {
        const { data: keyRows } = await supabase.from('connections').select('access_token').eq('site_id', req.siteId).eq('provider', 'square_key').limit(1);
        const { data: modeRows } = await supabase.from('connections').select('account_name').eq('site_id', req.siteId).eq('provider', 'square_mode').limit(1);
        const keyData = keyRows?.[0] || null;
        const modeData = modeRows?.[0] || null;
        if (!keyData?.access_token) return res.status(400).json({ error: 'Square not connected' });

        const token = decryptKey(keyData.access_token);
        const mode = modeData?.account_name || 'production';
        const locUrl = mode === 'sandbox'
            ? 'https://connect.squareupsandbox.com/v2/locations'
            : 'https://connect.squareup.com/v2/locations';
        const locRes = await fetch(locUrl, {
            headers: { 'Authorization': 'Bearer ' + token, 'Square-Version': '2024-01-18' }
        });
        const locData = await locRes.json();
        const locs = locData.locations || [];
        const primary = locs.find(l => l.status === 'ACTIVE') || locs[0];
        if (!primary) return res.status(404).json({ error: locData.errors?.[0]?.detail || 'No Square locations found' });

        const now = new Date().toISOString();
        await supabase.from('connections').delete().eq('site_id', req.siteId).eq('provider', 'square_location_id');
        await supabase.from('connections').insert({ site_id: req.siteId, provider: 'square_location_id', account_name: primary.id, status: 'connected', updated_at: now });

        res.json({ success: true, locationId: primary.id });
    } catch (err) {
        console.error('refresh-location error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// GET /api/square/connect-url (authRequired)
// Returns Square OAuth URL for client to authorize
// ============================================
router.get('/connect-url', authRequired, async (req, res) => {
    try {
        const { data: platformData } = await supabase
            .from('platform_settings')
            .select('value')
            .eq('key', 'api_key_square')
            .single();

        if (!platformData?.value?.appId) {
            return res.status(503).json({ error: 'Square not configured by platform admin yet' });
        }

        const { appId, mode } = platformData.value;
        const baseUrl = mode === 'sandbox'
            ? 'https://connect.squareupsandbox.com/oauth2/authorize'
            : 'https://connect.squareup.com/oauth2/authorize';

        const scopes = 'PAYMENTS_WRITE,PAYMENTS_READ,MERCHANT_PROFILE_READ';
        // Encode siteId + role so callback knows where to redirect after OAuth
        const state = Buffer.from(JSON.stringify({ siteId: req.siteId, role: req.role || 'owner' })).toString('base64url');
        const url = `${baseUrl}?client_id=${appId}&scope=${scopes}&session=false&state=${state}`;

        res.json({ url, mode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// GET /api/square/callback (public)
// Square OAuth callback — exchanges code for token, saves to connections
// ============================================
router.get('/callback', async (req, res) => {
    const { code, state: rawState, error } = req.query;

    // Decode state — new format is base64url JSON {siteId, role}, old format is plain siteId string
    let siteId, role = 'owner';
    try {
        const decoded = JSON.parse(Buffer.from(rawState, 'base64url').toString());
        siteId = decoded.siteId;
        role = decoded.role || 'owner';
    } catch (e) {
        siteId = rawState; // backward compat: plain siteId
    }

    const clientBase = 'https://cybercheck-login.vercel.app/index.html';
    const adminBase  = 'https://cybercheck-login.vercel.app/admin.html';
    const dashboardBase = role === 'admin' ? adminBase : clientBase;

    if (error) {
        return res.redirect(dashboardBase + '#connections?square_error=' + encodeURIComponent(error));
    }
    if (!code || !siteId) {
        return res.redirect(dashboardBase + '#connections?square_error=missing_code');
    }

    try {
        const { data: platformData } = await supabase
            .from('platform_settings')
            .select('value')
            .eq('key', 'api_key_square')
            .single();

        if (!platformData?.value?.appId || !platformData?.value?.secret) {
            return res.redirect(dashboardBase + '#connections?square_error=platform_not_configured');
        }

        const { appId, secret, mode } = platformData.value;
        const tokenUrl = mode === 'sandbox'
            ? 'https://connect.squareupsandbox.com/oauth2/token'
            : 'https://connect.squareup.com/oauth2/token';

        const tokenRes = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Square-Version': '2024-01-18' },
            body: JSON.stringify({
                client_id: appId,
                client_secret: secret,
                code,
                grant_type: 'authorization_code'
            })
        });

        const tokenData = await tokenRes.json();
        if (!tokenRes.ok || !tokenData.access_token) {
            const msg = tokenData.message || tokenData.errors?.[0]?.detail || 'Token exchange failed';
            return res.redirect(dashboardBase + '#connections?square_error=' + encodeURIComponent(msg));
        }

        // Save token + merchant info to connections
        const encrypted = encryptKey(tokenData.access_token);
        const now = new Date().toISOString();
        const merchantId = tokenData.merchant_id || '';

        // Fetch primary location ID directly from Square REST API (avoid SDK overhead in serverless)
        let locationId = '';
        let merchantName = '';
        try {
            const locUrl = mode === 'sandbox'
                ? 'https://connect.squareupsandbox.com/v2/locations'
                : 'https://connect.squareup.com/v2/locations';
            const locRes = await fetch(locUrl, {
                headers: { 'Authorization': 'Bearer ' + tokenData.access_token, 'Square-Version': '2024-01-18' }
            });
            const locData = await locRes.json();
            const locs = locData.locations || [];
            const primary = locs.find(l => l.status === 'ACTIVE') || locs[0];
            if (primary) {
                locationId = primary.id;
                merchantName = primary.business_name || primary.name || '';
            }
        } catch (e) {
            console.warn('Could not fetch Square location:', e.message);
        }

        const upserts = [
            supabase.from('connections').upsert({ site_id: siteId, provider: 'square_key', access_token: encrypted, account_name: merchantName || 'Square', status: 'connected', connected_at: now, updated_at: now }, { onConflict: 'site_id,provider' }),
            supabase.from('connections').upsert({ site_id: siteId, provider: 'square_mode', account_name: mode || 'production', status: 'connected', updated_at: now }, { onConflict: 'site_id,provider' }),
            supabase.from('connections').upsert({ site_id: siteId, provider: 'square_merchant_id', account_name: merchantId, status: 'connected', updated_at: now }, { onConflict: 'site_id,provider' }),
            supabase.from('connections').upsert({ site_id: siteId, provider: 'square_app_id', account_name: appId, status: 'connected', updated_at: now }, { onConflict: 'site_id,provider' })
        ];
        if (locationId) {
            upserts.push(supabase.from('connections').upsert({ site_id: siteId, provider: 'square_location_id', account_name: locationId, status: 'connected', updated_at: now }, { onConflict: 'site_id,provider' }));
        }
        await Promise.all(upserts);

        res.redirect(dashboardBase + '#connections?square_connected=true');
    } catch (err) {
        console.error('Square OAuth callback error:', err);
        res.redirect(dashboardBase + '#connections?square_error=' + encodeURIComponent(err.message));
    }
});

module.exports = router;
module.exports.getSquareForSite = getSquareForSite;
