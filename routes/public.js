const express = require('express');
const supabase = require('../db');

const router = express.Router();

// Serve the /api/public/menu response shape from the GCR DB.
// Used when entity.legacy_site_id matches the request's site_id — so a
// QR menu minted with ?site_id=X keeps working after the business is
// migrated to GCR.
async function serveMenuFromGcr(res, gcrDb, entity) {
    const entitySlug = entity.slug;
    const [menuSections, menuItems, drinkSections, drinkItems, hhSections, hhItems, events, specials, photos, hours, social, artistData] = await Promise.all([
        gcrDb.from('menu_sections').select('*').eq('entity_slug', entitySlug).order('sort_order', { ascending: true }),
        gcrDb.from('menu_items').select('*').eq('entity_slug', entitySlug).order('sort_order', { ascending: true }),
        gcrDb.from('drink_sections').select('*').eq('entity_slug', entitySlug).order('sort_order', { ascending: true }),
        gcrDb.from('drink_items').select('*').eq('entity_slug', entitySlug).order('sort_order', { ascending: true }),
        gcrDb.from('happy_hour_sections').select('*').eq('entity_slug', entitySlug).order('sort_order', { ascending: true }),
        gcrDb.from('happy_hour_items').select('*').eq('entity_slug', entitySlug).order('sort_order', { ascending: true }),
        gcrDb.from('entity_events').select('*').eq('entity_slug', entitySlug).order('event_date', { ascending: true }),
        gcrDb.from('entity_specials').select('*').eq('entity_slug', entitySlug),
        gcrDb.from('entity_photos').select('*').eq('entity_slug', entitySlug).order('sort_order', { ascending: true }),
        gcrDb.from('entity_hours').select('*').eq('entity_slug', entitySlug),
        Promise.resolve({ data: [] }), // social_media_accounts is legacy/site_id-keyed OAuth data, not applicable here — modern social links come straight off entity.social_instagram/facebook/tiktok below
        entity.live_artist_id ? gcrDb.from('artist_profiles').select('id, artist_name, slug, bio, photo_url, cashtag, venmo, request_enabled, shoutout_enabled, default_min_request_amount').eq('id', entity.live_artist_id).eq('is_active', true).maybeSingle() : Promise.resolve({ data: null }),
    ]);

    const groupItems = (sections, items, priceField) => {
        const byId = {};
        (sections.data || []).forEach(s => { byId[s.id] = { name: s.section_name, items: [] }; });
        (items.data || []).forEach(i => {
            const bucket = byId[i.section_id];
            if (!bucket) return;
            bucket.items.push({
                id: i.id,
                name: i.item_name,
                description: i.description || '',
                price: parseFloat(i[priceField] ?? i.price ?? 0) || 0,
                photo_url: i.image_url || '',
                image_url: i.image_url || '',
                tags: Array.isArray(i.tags) ? i.tags : [],
                modifiers: Array.isArray(i.modifiers) ? i.modifiers : [],
            });
        });
        return Object.values(byId).filter(s => s.items.length);
    };

    const foodSections = groupItems(menuSections, menuItems, 'price');
    const drinkSectionsOut = groupItems(drinkSections, drinkItems, 'price');
    const hhSectionsOut = groupItems(hhSections, hhItems, 'hh_price');

    const social_links = {};
    (social.data || []).forEach(s => { if (s.account_url) social_links[s.platform] = s.account_url; });
    if (entity.social_instagram) social_links.instagram = entity.social_instagram;
    if (entity.social_facebook) social_links.facebook = entity.social_facebook;
    if (entity.social_tiktok) social_links.tiktok = entity.social_tiktok;

    return res.json({
        business_name: entity.name || '',
        logo_url: entity.hero_image_url || '',
        tagline: '',
        hours: (hours.data || []).reduce((acc, h) => {
            acc[h.day_of_week] = h.is_closed ? 'Closed' : `${h.opens_at || ''} - ${h.closes_at || ''}`.trim();
            return acc;
        }, {}),
        social_links: Object.keys(social_links).length ? social_links : null,
        address: entity.address_line_1 || '',
        phone: entity.phone || entity.national_phone || '',
        sections: {
            food: foodSections.map(s => ({ name: s.name, items: s.items })),
            drink: drinkSectionsOut.map(s => ({ name: s.name, items: s.items })),
            happy_hour: hhSectionsOut.map(s => ({ name: s.name, items: s.items })),
        },
        menu: foodSections.map(s => ({ category: s.name, items: s.items })),
        events: events.data || [],
        specials: specials.data || [],
        photos: photos.data || [],
        hh_schedule: {
            days: entity.hh_days || null,
            start: entity.hh_start || null,
            end: entity.hh_end || null,
        },
        hh_description: entity.hh_description || null,
        live_artist: artistData?.data || null,
    });
}

// All public routes need a site_id from domain resolution middleware
// If no site_id, the request needs a ?subdomain= param as fallback
function requireSite(req, res, next) {
    // Accept ?site_id= as the simplest fallback (used by qr-menu.html)
    if (!req.siteId && (req.query.site_id || (req.body && req.body.site_id))) {
        req.siteId = req.query.site_id || req.body.site_id;
        return next();
    }

    if (!req.siteId && (req.query.subdomain || (req.body && req.body.subdomain))) {
        // Fallback: look up by subdomain query param
        supabase
            .from('businesses')
            .select('site_id, name, type, status')
            .eq('subdomain', req.query.subdomain || req.body.subdomain)
            .single()
            .then(({ data }) => {
                if (!data || data.status !== 'active') {
                    return res.status(404).json({ error: 'Business not found' });
                }
                req.siteId = data.site_id;
                req.siteName = data.name;
                req.siteType = data.type;
                next();
            });
        return;
    }

    if (!req.siteId) {
        return res.status(404).json({ error: 'Business not found. Provide domain, ?site_id= or ?subdomain= param.' });
    }
    next();
}

// ============================================
// POST /api/public/waivers/send-link — Dashboard: manually send waiver link (no site required)
// ============================================
router.post('/waivers/send-link', async (req, res) => {
    const { booking_id } = req.body;
    if (!booking_id) return res.status(400).json({ error: 'booking_id required' });

    try {
        const { sendEmail } = require('../utils/email');

        // Get booking first
        const { data: booking } = await supabase
            .from('bookings')
            .select('customer_email, customer_name, site_id')
            .eq('id', booking_id)
            .single();

        if (!booking?.customer_email) return res.status(400).json({ error: 'No customer email on file' });

        // Check if already signed — don't create a new record if so
        const { data: signedWaiver } = await supabase
            .from('waivers')
            .select('id, signed_at')
            .eq('booking_id', booking_id)
            .not('signed_at', 'is', null)
            .maybeSingle();

        if (signedWaiver) {
            return res.status(200).json({ success: true, already_signed: true });
        }

        // Find existing unsigned waiver, or create one
        let { data: waiver } = await supabase
            .from('waivers')
            .select('id, customer_name, site_id')
            .eq('booking_id', booking_id)
            .is('signed_at', null)
            .maybeSingle();

        if (!waiver) {
            const { data: created, error: insertErr } = await supabase
                .from('waivers')
                .insert({ site_id: booking.site_id, booking_id, customer_name: booking.customer_name })
                .select('id, customer_name, site_id')
                .single();
            if (insertErr) return res.status(500).json({ error: insertErr.message });
            waiver = created;
        }

        if (!waiver) return res.status(500).json({ error: 'Could not create waiver record' });

        const { data: biz } = await supabase
            .from('businesses')
            .select('subdomain, custom_domain')
            .eq('site_id', waiver.site_id)
            .maybeSingle();

        const domain = biz?.custom_domain
            || (biz?.subdomain ? `https://${biz.subdomain}.cybercheck.com` : 'https://circle-boats-main.vercel.app');
        const waiverUrl = `${((process.env.PUBLIC_SITE_BASE_URL || domain).trim())}/waiver-form.html?token=${waiver.id}`;

        const name = booking.customer_name || waiver.customer_name || 'there';
        const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr><td style="background:#f59e0b;padding:28px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;">Please Sign Your Waiver</h1>
          <p style="margin:8px 0 0;color:#fef3c7;font-size:14px;">Required before your booking</p>
        </td></tr>
        <tr><td style="padding:32px;text-align:center;">
          <p style="margin:0 0 24px;color:#374151;font-size:15px;">Hi <strong>${name}</strong>, please sign your waiver to complete your booking.</p>
          <a href="${waiverUrl}" style="display:inline-block;background:#f59e0b;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 40px;border-radius:10px;">✍️ Sign Your Waiver →</a>
          <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">This link is unique to your booking. Do not share it.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

        const result = await sendEmail({ to: booking.customer_email, subject: 'Please Sign Your Waiver', html });
        if (!result.success) return res.status(500).json({ error: result.reason || 'Email failed' });
        res.json({ success: true });
    } catch (err) {
        console.error('send-link error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/public/resend-confirmation — no site required, resolves from booking
// ============================================
router.post('/resend-confirmation', async (req, res) => {
    const { booking_id } = req.body;
    if (!booking_id) return res.status(400).json({ error: 'booking_id required' });

    try {
        const { sendSms, fillTemplate, buildTemplateData } = require('../utils/sms');
        const { sendEmail, customerConfirmationHtml, generateIcsContent } = require('../utils/email');

        const { data: bookingData } = await supabase
            .from('bookings')
            .select('*')
            .eq('id', booking_id)
            .single();

        if (!bookingData) return res.status(404).json({ error: 'Booking not found' });

        const siteId = bookingData.site_id;
        const templateData = await buildTemplateData(bookingData, siteId);

        if (bookingData.customer_phone) {
            const tpl = '[{{business_name}}] Hi {{customer_name}}! Your booking is confirmed.\n\nDate: {{date}}\nTime: {{time_slot}}\nTotal: ${{total}}\n\nQuestions? Reply to this number!';
            await sendSms(bookingData.customer_phone, fillTemplate(tpl, templateData), siteId, 'booking_confirmation', booking_id)
                .catch(err => console.error('Resend SMS failed:', err));
        }

        if (bookingData.customer_email) {
            const attachments = [{ filename: 'booking.ics', content: Buffer.from(generateIcsContent(templateData)).toString('base64') }];

            // ── Fetch waiver if booking has one ──
            try {
                const { data: waiver, error: waiverError } = await supabase
                    .from('signed_waivers')
                    .select('id, waiver_pdf_url, signed_at, signature')
                    .eq('booking_id', booking_id)
                    .maybeSingle();

                if (waiver && !waiverError) {
                    templateData.waiver_acknowledgment = true;
                    templateData.waiver_pdf = waiver.waiver_pdf_url;

                    // ── Attach waiver PDF if available ──
                    if (waiver.waiver_pdf_url) {
                        try {
                            const waiverResponse = await fetch(waiver.waiver_pdf_url);
                            if (waiverResponse.ok) {
                                const waiverBuffer = await waiverResponse.arrayBuffer();
                                attachments.push({
                                    filename: 'waiver-agreement.pdf',
                                    content: Buffer.from(waiverBuffer).toString('base64')
                                });
                            }
                        } catch (err) {
                            console.warn('Could not fetch waiver PDF:', err.message);
                        }
                    }
                }
            } catch (err) {
                console.warn('Waiver fetch error (continuing with email):', err.message);
            }

            const customerEmailResult = await sendEmail({
                to: bookingData.customer_email,
                subject: 'Booking Confirmed — ' + (templateData.business_name || 'Your Reservation'),
                html: customerConfirmationHtml(templateData),
                attachments: attachments
            });
            console.log('Customer email result:', JSON.stringify(customerEmailResult), '→', bookingData.customer_email);
        }

        // ── Owner / CC notification emails ──
        const { ownerNotificationHtml } = require('../utils/email');
        const { data: siteContentData } = await supabase
            .from('site_content')
            .select('messaging_settings, contact_email')
            .eq('site_id', siteId)
            .maybeSingle();
        const { data: business } = await supabase
            .from('businesses')
            .select('name, email')
            .eq('site_id', siteId)
            .maybeSingle();

        const msgSettings = siteContentData?.messaging_settings || {};
        const emailList = [];
        if (msgSettings.notification_email) emailList.push(msgSettings.notification_email);
        if (msgSettings.notification_email_2) emailList.push(msgSettings.notification_email_2);
        if (!emailList.length) {
            if (siteContentData?.contact_email) emailList.push(siteContentData.contact_email);
            else if (business?.email) emailList.push(business.email);
        }
        console.log('Owner email list:', emailList);
        if (emailList.length) {
            const ownerEmailResult = await sendEmail({
                to: emailList,
                subject: 'Booking Confirmed — ' + (templateData.customer_name || 'Customer') + ' · ' + templateData.date,
                html: ownerNotificationHtml(templateData),
                replyTo: bookingData.customer_email || undefined
            });
            console.log('Owner email result:', JSON.stringify(ownerEmailResult));
        }

        res.json({ success: true, message: 'Confirmations resent to customer' });
    } catch (err) {
        console.error('Resend confirmation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// GET /api/public/waivers/:token — Fetch waiver to sign (no site required — token identifies record)
// ============================================
router.get('/waivers/:token', async (req, res) => {
    const token = req.params.token;
    const { data: waiver } = await supabase
        .from('waivers')
        .select('id, waiver_text, customer_name, booking_id, signed_at, site_id')
        .eq('id', token)
        .maybeSingle();

    if (!waiver) return res.status(404).json({ error: 'Waiver link not found or expired' });
    if (waiver.signed_at) return res.status(410).json({ error: 'Waiver already signed' });

    let waiverText = waiver.waiver_text;
    if (!waiverText && waiver.site_id) {
        const { data: tmpl } = await supabase
            .from('waivers')
            .select('waiver_text')
            .eq('site_id', waiver.site_id)
            .is('booking_id', null)
            .limit(1)
            .maybeSingle();
        waiverText = tmpl?.waiver_text || '';
    }

    res.json({ waiver_text: waiverText, customer_name: waiver.customer_name || '', booking_id: waiver.booking_id, token });
});

// ============================================
// POST /api/public/waivers/:token/sign — Sign a waiver by token (no site required)
// ============================================
router.post('/waivers/:token/sign', async (req, res) => {
    const token = req.params.token;
    const { customer_name, customer_email, signature_data, waiver_text } = req.body;

    if (!customer_name || !signature_data) {
        return res.status(400).json({ error: 'Customer name and signature required' });
    }

    const { data: existing } = await supabase
        .from('waivers')
        .select('id, booking_id, signed_at, site_id')
        .eq('id', token)
        .maybeSingle();

    if (!existing) return res.status(404).json({ error: 'Waiver link not found' });
    if (existing.signed_at) return res.status(410).json({ error: 'Waiver already signed' });

    const { data, error } = await supabase
        .from('waivers')
        .update({
            customer_name,
            customer_email: customer_email || null,
            signature_data,
            waiver_text: waiver_text || null,
            signed_at: new Date().toISOString(),
            ip_address: req.ip
        })
        .eq('id', existing.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    if (existing.booking_id) {
        await supabase.from('bookings').update({ waiver_signed: true }).eq('id', existing.booking_id);

        // Create dashboard notification
        const { data: booking } = await supabase
            .from('bookings')
            .select('site_id, customer_name')
            .eq('id', existing.booking_id)
            .maybeSingle();

        if (booking?.site_id) {
            await supabase.from('notifications').insert({
                site_id: booking.site_id,
                type: 'waiver_signed',
                title: 'Waiver Signed',
                message: (booking.customer_name || 'A customer') + ' has signed their waiver.',
                booking_id: existing.booking_id,
                read: false,
                created_at: new Date().toISOString()
            }).catch(err => console.warn('Waiver notification insert failed:', err.message));

            // Admin SMS
            const adminPhone = process.env.ADMIN_SMS_NUMBER;
            if (adminPhone) {
                try {
                    const { sendSms } = require('../utils/sms');
                    const { data: biz } = await supabase.from('businesses').select('name').eq('site_id', booking.site_id).single();
                    const { data: fullBooking } = await supabase.from('bookings').select('customer_phone, booking_date, total').eq('id', existing.booking_id).single();
                    const bizName = biz?.name || 'Client';
                    const msg = `[${bizName}] WAIVER SIGNED\n${booking.customer_name} · ${fullBooking?.customer_phone || 'no phone'}\n${fullBooking?.booking_date || ''} · $${fullBooking?.total || ''}`;
                    sendSms(adminPhone, msg, booking.site_id, 'waiver_signed_notify', existing.booking_id).catch(() => {});
                } catch (e) { console.error('Admin waiver SMS error:', e.message); }
            }
        }
    }

    res.json({ success: true, waiver_id: data.id });
});

router.use(requireSite);

// ============================================
// GET /api/public/profile
// ============================================
router.get('/profile', async (req, res) => {
    const { data: business } = await supabase
        .from('businesses')
        .select('name, type, logo_url, cover_url, subdomain, domain')
        .eq('site_id', req.siteId)
        .single();

    const { data: content } = await supabase
        .from('site_content')
        .select('hero_text, hero_subtext, hero_video_url, about_text, contact_phone, contact_email, address, city, state, zip, lat, lng, hours, social_links, logo_url, cover_url, theme_color, seo_title, seo_description, ga4_id, facebook_pixel_id')
        .eq('site_id', req.siteId)
        .single();

    const profile = { ...business, ...content };
    // Alias for consistency — some clients use tagline, DB column is hero_text
    if (profile.hero_text !== undefined) profile.tagline = profile.hero_text;
    res.json(profile);
});

// ============================================
// GET /api/public/services
// ============================================
router.get('/services', async (req, res) => {
    const { data } = await supabase
        .from('services')
        .select('id, name, description, price, duration_minutes, capacity, image_url, category')
        .eq('site_id', req.siteId)
        .eq('available', true)
        .order('sort_order', { ascending: true });

    res.json(data || []);
});

// Duplicate /menu route removed — it shadowed the working ?site_id=/?slug=
// handler later in this file and broke qr-menu.html. The remaining
// definition at "GET /menu" below handles all cases.

// ============================================
// GET /api/public/gallery
// ============================================
router.get('/gallery', async (req, res) => {
    const { data: content } = await supabase
        .from('site_content')
        .select('gallery')
        .eq('site_id', req.siteId)
        .single();

    // Also get media library images
    const { data: media } = await supabase
        .from('media')
        .select('id, url, alt_text, filename')
        .eq('site_id', req.siteId)
        .eq('file_type', 'image')
        .eq('folder', 'gallery');

    res.json({
        gallery: content?.gallery || [],
        media: media || []
    });
});

// ============================================
// GET /api/public/reviews
// ============================================
router.get('/reviews', async (req, res) => {
    const { data } = await supabase
        .from('reviews')
        .select('id, customer_name, rating, text, photos, created_at')
        .eq('site_id', req.siteId)
        .eq('status', 'published')
        .order('created_at', { ascending: false });

    // Calculate average rating
    const reviews = data || [];
    const avgRating = reviews.length > 0
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
        : 0;

    res.json({ reviews, avg_rating: Math.round(avgRating * 10) / 10, total: reviews.length });
});

// ============================================
// GET /api/public/faqs
// ============================================
router.get('/faqs', async (req, res) => {
    const { data } = await supabase
        .from('faqs')
        .select('id, question, answer')
        .eq('site_id', req.siteId)
        .order('sort_order', { ascending: true });

    res.json(data || []);
});

// ============================================
// GET /api/public/hours
// ============================================
router.get('/hours', async (req, res) => {
    const { data } = await supabase
        .from('site_content')
        .select('hours')
        .eq('site_id', req.siteId)
        .single();

    res.json(data?.hours || {});
});

// ============================================
// GET /api/public/team
// ============================================
router.get('/team', async (req, res) => {
    const { data } = await supabase
        .from('staff')
        .select('name, role, phone, email')
        .eq('site_id', req.siteId)
        .eq('active', true);

    res.json(data || []);
});

// ============================================
// GET /api/public/specials
// ============================================
router.get('/specials', async (req, res) => {
    const { data } = await supabase
        .from('specials')
        .select('id, name, description, type, days, start_time, end_time, discount_text, image_url')
        .eq('site_id', req.siteId)
        .eq('active', true);

    res.json(data || []);
});

// ============================================
// GET /api/public/social
// ============================================
router.get('/social', async (req, res) => {
    const { data } = await supabase
        .from('site_content')
        .select('social_links')
        .eq('site_id', req.siteId)
        .single();

    res.json(data?.social_links || {});
});

// ============================================
// GET /api/public/fleet — rental fleet types + pricing
// ============================================
router.get('/fleet', async (req, res) => {
    const { data: fleet } = await supabase
        .from('fleet_types')
        .select('id, name, description, specs, image_url')
        .eq('site_id', req.siteId)
        .eq('available', true)
        .order('sort_order', { ascending: true });

    const { data: timeSlots } = await supabase
        .from('rental_time_slots')
        .select('id, name, start_time, end_time')
        .eq('site_id', req.siteId)
        .eq('active', true)
        .order('sort_order', { ascending: true });

    const { data: pricing } = await supabase
        .from('rental_pricing')
        .select('fleet_type_id, time_slot_id, price')
        .eq('site_id', req.siteId);

    const { data: addons } = await supabase
        .from('rental_addons')
        .select('id, name, description, price, category, icon, per_unit, image_url')
        .eq('site_id', req.siteId)
        .eq('available', true)
        .order('sort_order', { ascending: true });

    const { data: groupRates } = await supabase
        .from('rental_group_rates')
        .select('fleet_type_id, time_slot_id, min_qty, price_per_unit')
        .eq('site_id', req.siteId)
        .eq('active', true);

    res.json({
        fleet: fleet || [],
        time_slots: timeSlots || [],
        pricing: pricing || [],
        addons: addons || [],
        group_rates: groupRates || []
    });
});

// ============================================
// GET /api/public/blackout-dates
// ============================================
router.get('/blackout-dates', async (req, res) => {
    const { data } = await supabase
        .from('blackout_dates')
        .select('id, date_from, date_to, label')
        .eq('site_id', req.siteId)
        .order('date_from', { ascending: true });
    res.json({ blackout_dates: data || [] });
});

// ============================================
// GET /api/public/availability?date=YYYY-MM-DD
// ============================================
router.get('/availability', async (req, res) => {
    const { date } = req.query;
    if (!date) {
        return res.status(400).json({ error: 'date query parameter required (YYYY-MM-DD)' });
    }

    // Get all bookings for that date
    const { data: bookings } = await supabase
        .from('bookings')
        .select('fleet_type_id, time_slot_id, qty, status')
        .eq('site_id', req.siteId)
        .eq('booking_date', date)
        .in('status', ['pending', 'confirmed', 'checked_in']);

    // Get fleet inventory counts
    const { data: fleetItems } = await supabase
        .from('fleet_items')
        .select('fleet_type_id, condition')
        .eq('site_id', req.siteId)
        .eq('condition', 'good');

    // Get time slots
    const { data: timeSlots } = await supabase
        .from('rental_time_slots')
        .select('id, name, start_time, end_time')
        .eq('site_id', req.siteId)
        .eq('active', true);

    // Get fleet types
    const { data: fleetTypes } = await supabase
        .from('fleet_types')
        .select('id, name, specs')
        .eq('site_id', req.siteId)
        .eq('available', true);

    // Get active holds (other people in checkout right now)
    const { data: holds } = await supabase
        .from('booking_holds')
        .select('fleet_type_id, time_slot_id, qty')
        .eq('site_id', req.siteId)
        .eq('booking_date', date)
        .gt('expires_at', new Date().toISOString());

    // Calculate availability: total units - booked units - held units
    const inventory = {};
    (fleetItems || []).forEach(item => {
        inventory[item.fleet_type_id] = (inventory[item.fleet_type_id] || 0) + 1;
    });

    const booked = {};
    const bookedNoSlot = {}; // bookings with no time_slot_id count against all slots
    (bookings || []).forEach(b => {
        if (b.time_slot_id) {
            const key = `${b.fleet_type_id}_${b.time_slot_id}`;
            booked[key] = (booked[key] || 0) + (b.qty || 1);
        } else {
            bookedNoSlot[b.fleet_type_id] = (bookedNoSlot[b.fleet_type_id] || 0) + (b.qty || 1);
        }
    });

    // Add holds to booked count
    (holds || []).forEach(h => {
        if (h.time_slot_id) {
            const key = `${h.fleet_type_id}_${h.time_slot_id}`;
            booked[key] = (booked[key] || 0) + (h.qty || 1);
        } else {
            bookedNoSlot[h.fleet_type_id] = (bookedNoSlot[h.fleet_type_id] || 0) + (h.qty || 1);
        }
    });

    // Check blocked dates — check both legacy 'availability' table and new 'availability_blocks' table
    const [{ data: blockedLegacy }, { data: blockedNew }] = await Promise.all([
        supabase.from('availability').select('service_id, blocked')
            .eq('site_id', req.siteId).eq('specific_date', date).eq('blocked', true),
        supabase.from('availability_blocks').select('fleet_type_id')
            .eq('site_id', req.siteId).eq('block_date', date)
    ]);

    // blockAll = whole-date block (no specific fleet); blockedSet = specific fleet type blocked
    const blockAllLegacy = (blockedLegacy || []).some(b => !b.service_id);
    const blockAllNew = (blockedNew || []).some(b => !b.fleet_type_id);
    const blockAll = blockAllLegacy || blockAllNew;
    const blockedSet = new Set([
        ...(blockedLegacy || []).filter(b => b.service_id).map(b => b.service_id),
        ...(blockedNew || []).filter(b => b.fleet_type_id).map(b => b.fleet_type_id)
    ]);

    const availability = [];
    (fleetTypes || []).forEach(ft => {
        (timeSlots || []).forEach(ts => {
            const key = `${ft.id}_${ts.id}`;
            // Always use specs.qty as the source of truth — fleet_items are not kept in sync with actual qty
            const specsQty = (ft.specs && typeof ft.specs === 'object') ? (ft.specs.qty || 0) : 0;
            const total = specsQty || (inventory[ft.id] || 0);
            const used = (booked[key] || 0) + (bookedNoSlot[ft.id] || 0);
            const remaining = Math.max(0, total - used);

            availability.push({
                fleet_type_id: ft.id,
                fleet_type_name: ft.name,
                time_slot_id: ts.id,
                time_slot_name: ts.name,
                start_time: ts.start_time,
                end_time: ts.end_time,
                total,
                booked: used,
                available: remaining,
                blocked: blockAll || blockedSet.has(ft.id)
            });
        });
    });

    res.json({ date, availability });
});

// ============================================
// POST /api/public/hold — Reserve slot during checkout (10 min)
// Prevents overbooking while customer is filling out payment
// ============================================
async function isDateBlackedOut(siteId, dateStr) {
    if (!dateStr) return false;
    const { data } = await supabase
        .from('blackout_dates')
        .select('id')
        .eq('site_id', siteId)
        .lte('date_from', dateStr)
        .gte('date_to', dateStr)
        .limit(1);
    return data && data.length > 0;
}

router.post('/hold', async (req, res) => {
    const { fleet_type_id, time_slot_id, booking_date, qty, session_id } = req.body;
    const resolvedSessionId = session_id || ('session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));

    // Blackout check first — before any other validation
    if (booking_date && await isDateBlackedOut(req.siteId, booking_date)) {
        return res.status(409).json({ error: 'This date is not available for booking.' });
    }

    if (!fleet_type_id || !booking_date) {
        return res.status(400).json({ error: 'fleet_type_id and booking_date required' });
    }

    // If no time_slot_id (e.g. duration-based rentals), skip RPC hold and return success
    if (!time_slot_id) {
        return res.json({ success: true, hold_id: resolvedSessionId, expires_in_seconds: 600, session_id: resolvedSessionId });
    }

    const { data, error } = await supabase.rpc('create_booking_hold', {
        p_site_id: req.siteId,
        p_fleet_type_id: fleet_type_id,
        p_time_slot_id: time_slot_id,
        p_booking_date: booking_date,
        p_qty: qty || 1,
        p_session_id: resolvedSessionId
    });

    if (error) return res.status(500).json({ error: error.message });

    const result = data;
    if (!result.success) {
        return res.status(409).json(result);
    }

    res.json(result);
});

// ============================================
// DELETE /api/public/hold — Release a hold (customer abandons checkout)
// ============================================
router.delete('/hold', async (req, res) => {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });

    await supabase.from('booking_holds')
        .delete()
        .eq('session_id', session_id)
        .eq('site_id', req.siteId);

    res.json({ success: true });
});

// ============================================
// POST /api/public/bookings — Create booking (atomic availability check)
// ============================================
// POST /api/public/bookings/:id/payment-failed — mark booking as payment failed
// ============================================
router.post('/bookings/:id/payment-failed', async (req, res) => {
    const { data: booking } = await supabase
        .from('bookings')
        .update({ payment_status: 'failed', status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select('customer_name, customer_phone, total, booking_date, site_id')
        .single();
    res.json({ success: true });

    const adminPhone = process.env.ADMIN_SMS_NUMBER;
    if (adminPhone && booking) {
        try {
            const { sendSms } = require('../utils/sms');
            const { data: biz } = await supabase.from('businesses').select('name').eq('site_id', booking.site_id).single();
            const bizName = biz?.name || 'Client';
            const msg = `[${bizName}] PAYMENT FAILED\n${booking.customer_name} · ${booking.customer_phone || 'no phone'}\n${booking.booking_date} · $${booking.total}\nRetry: https://cybercheck-login.vercel.app/`;
            sendSms(adminPhone, msg, booking.site_id, 'payment_failed_notify', req.params.id).catch(() => {});
        } catch (e) { console.error('Admin payment-failed SMS error:', e.message); }
    }
});

// ============================================
router.post('/bookings', async (req, res) => {
    if (await isDateBlackedOut(req.siteId, req.body.booking_date)) {
        return res.status(409).json({ error: 'This date is not available for booking.' });
    }

    const booking = {
        site_id: req.siteId,
        fleet_type_id: req.body.fleet_type_id,
        service_id: req.body.service_id,
        time_slot_id: req.body.time_slot_id,
        booking_date: req.body.booking_date,
        booking_time: req.body.booking_time,
        qty: req.body.qty || 1,
        party_size: req.body.party_size || 1,
        addons: req.body.addons || [],
        subtotal: req.body.subtotal,
        tax: req.body.tax || 0,
        total: req.body.total,
        customer_name: req.body.customer_name,
        customer_phone: req.body.customer_phone,
        customer_email: req.body.customer_email,
        notes: req.body.notes,
        status: 'pending',
        payment_status: 'unpaid',
        sms_consent: req.body.sms_consent === true,
        sms_consent_at: req.body.sms_consent === true ? new Date().toISOString() : null,
        sms_consent_ip: req.body.sms_consent === true ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null) : null,
        sms_consent_text: req.body.sms_consent === true ? (req.body.sms_consent_text || null) : null
    };

    // Upsert customer — single query instead of check+insert to reduce latency
    let customerId = null;
    const customerKey = booking.customer_email || booking.customer_phone;
    if (customerKey) {
        const matchCol = booking.customer_email ? 'email' : 'phone';
        const { data: existingCustomer } = await supabase
            .from('customers')
            .select('id')
            .eq('site_id', req.siteId)
            .eq(matchCol, customerKey)
            .maybeSingle();

        if (existingCustomer) {
            customerId = existingCustomer.id;
            supabase.rpc('increment_customer_bookings', {
                customer_uuid: existingCustomer.id,
                amount: booking.total || 0
            }).then(() => {}).catch(() => {});  // fire-and-forget
        } else {
            const { data: newCustomer } = await supabase
                .from('customers')
                .insert({
                    site_id: req.siteId,
                    name: booking.customer_name,
                    phone: booking.customer_phone,
                    email: booking.customer_email || null,
                    total_bookings: 1,
                    total_spent: booking.total || 0
                })
                .select('id')
                .single();
            if (newCustomer) customerId = newCustomer.id;
        }
    }

    // Use atomic function if fleet booking (rental), otherwise direct insert (service booking)
    let data, error;

    if (booking.fleet_type_id && booking.time_slot_id && booking.booking_date) {
        // Try atomic RPC first (prevents overbooking), fall back to direct insert if RPC missing/timeout
        const { data: result, error: rpcError } = await supabase.rpc('create_booking_if_available', {
            p_site_id: req.siteId,
            p_fleet_type_id: booking.fleet_type_id,
            p_time_slot_id: booking.time_slot_id,
            p_booking_date: booking.booking_date,
            p_qty: booking.qty,
            p_service_id: booking.service_id || null,
            p_booking_time: booking.booking_time || null,
            p_party_size: booking.party_size,
            p_addons: JSON.stringify(booking.addons),
            p_subtotal: booking.subtotal || 0,
            p_tax: booking.tax || 0,
            p_total: booking.total || 0,
            p_customer_id: customerId,
            p_customer_name: booking.customer_name,
            p_customer_phone: booking.customer_phone,
            p_customer_email: booking.customer_email,
            p_notes: booking.notes || null,
            p_hold_session_id: req.body.session_id || null
        });

        if (rpcError) {
            // RPC failed — return error, never bypass inventory check with direct insert
            console.error('RPC create_booking_if_available failed:', rpcError.message);
            return res.status(500).json({ error: 'Booking system temporarily unavailable. Please try again in a moment.' });
        } else if (!result.success) {
            return res.status(409).json({ error: result.error, available: result.available });
        } else {
            if (booking.sms_consent) {
                await supabase.from('bookings').update({
                    sms_consent: true,
                    sms_consent_at: booking.sms_consent_at,
                    sms_consent_ip: booking.sms_consent_ip,
                    sms_consent_text: booking.sms_consent_text
                }).eq('id', result.booking_id);
            }
            const { data: fullBooking } = await supabase.from('bookings').select().eq('id', result.booking_id).single();
            data = fullBooking;
        }
    } else {
        // Service booking or booking without fleet — direct insert (no inventory to check)
        booking.customer_id = customerId;
        const insertResult = await supabase
            .from('bookings')
            .insert(booking)
            .select()
            .single();
        data = insertResult.data;
        error = insertResult.error;
    }

    if (error) return res.status(500).json({ error: error.message });

    // Link waiver to booking if waiver_token was passed (legacy flow: waiver signed before booking created)
    if (req.body.waiver_token) {
        await supabase.from('waivers')
            .update({ booking_id: data.id })
            .eq('id', req.body.waiver_token)
            .catch(err => console.error('Waiver link failed:', err));
    }

    // Respond immediately — don't block on SMS (prevents 504 timeout)
    res.status(201).json(data);

    // Send SMS + email notifications after response (fire-and-forget, won't cause timeout)
    setImmediate(async () => {
        try {
            const { sendSms, fillTemplate, buildTemplateData } = require('../utils/sms');
            const { sendEmail, customerConfirmationHtml, ownerNotificationHtml, generateIcsContent } = require('../utils/email');

            // Get messaging settings + contact info in one shot
            const [{ data: msgSettingsData }, { data: siteContent }, { data: business }] = await Promise.all([
                supabase.from('messaging_settings').select('*').eq('site_id', req.siteId).maybeSingle(),
                supabase.from('site_content').select('contact_phone, contact_email').eq('site_id', req.siteId).single(),
                supabase.from('businesses').select('name, email').eq('site_id', req.siteId).single()
            ]);
            const msgSettings = msgSettingsData || {};

            // Create waiver record for this booking
            await supabase.from('waivers').insert({
                site_id: req.siteId,
                booking_id: data.id,
                customer_name: data.customer_name,
                customer_email: data.customer_email
            }).catch(err => console.error('Waiver record creation failed:', err));

            const settings = msgSettings;
            const templateData = await buildTemplateData(data, req.siteId);
            // Attach notes to templateData for email templates
            templateData.notes = data.notes || '';

            // ── Customer SMS + Email — sent after payment confirms (see square.js) ──

            // ── Admin SMS (platform owner) — full details ──
            const adminPhone = process.env.ADMIN_SMS_NUMBER;
            if (adminPhone) {
                const bizName = business?.name || templateData.business_name || 'Client';
                const adminMsg = [
                    `[${bizName}] NEW BOOKING`,
                    `Ref: ${templateData.confirmation_number}`,
                    ``,
                    `${data.customer_name}`,
                    `Ph: ${data.customer_phone || 'N/A'}`,
                    `Em: ${data.customer_email || 'N/A'}`,
                    ``,
                    `${templateData.date}`,
                    `${templateData.time_slot}`,
                    `${templateData.boat_count}x ${templateData.boat_type}`,
                    `Guests: ${templateData.guest_count}`,
                    `Add-ons: ${templateData.addons}`,
                    `Location: ${templateData.location}`,
                    ``,
                    `Total: $${templateData.total}`,
                    `Payment: ${templateData.payment_status}`,
                    ``,
                    `Notes: ${data.notes || 'None'}`,
                    `Source: ${templateData.utm_source} · ${templateData.device_type}`
                ].join('\n');
                sendSms(adminPhone, adminMsg, req.siteId, 'booking_owner_notify', data.id)
                    .catch(err => console.error('Admin SMS failed:', err));
            }

            // ── Owner Email ──
            // Collect all emails: primary, secondary (CC), contact_email, business email
            const emailList = [];
            if (msgSettings.notification_email) emailList.push(msgSettings.notification_email);
            if (msgSettings.notification_email_2) emailList.push(msgSettings.notification_email_2);
            if (!msgSettings.notification_email && !msgSettings.notification_email_2) {
              // Fallback to contact_email or business email if no notification emails set
              if (siteContent?.contact_email) emailList.push(siteContent.contact_email);
              else if (business?.email) emailList.push(business.email);
            }
            const ownerEmail = emailList.length ? emailList : null;
            if (ownerEmail && ownerEmail.length) {
                sendEmail({
                    to: ownerEmail,
                    subject: 'New Booking — ' + (templateData.customer_name || 'Customer') + ' · ' + templateData.date,
                    html: ownerNotificationHtml(templateData),
                    replyTo: data.customer_email || undefined
                }).catch(err => console.error('Owner email failed:', err));
            }

        } catch (notifyErr) {
            console.error('Notification error:', notifyErr);
        }
    });
});

// ============================================
// POST /api/public/track — Page view + conversion tracking
// ============================================
router.post('/track', async (req, res) => {
    const { type, page_path, page_title, referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content, device_type, browser, os, session_id, duration_seconds, conversion_type, conversion_value, booking_id, customer_email, customer_name } = req.body;

    try {
        if (type === 'pageview' || !type) {
            await supabase.from('page_views').insert({
                site_id: req.siteId,
                page_path:   page_path || '/',
                page_title:  page_title || null,
                referrer:    referrer || null,
                utm_source:  utm_source || null,
                utm_medium:  utm_medium || null,
                utm_campaign: utm_campaign || null,
                utm_term:    utm_term || null,
                utm_content: utm_content || null,
                device_type: device_type || null,
                browser:     browser || null,
                os:          os || null,
                session_id:  session_id || null,
                ip_address:  req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null,
                duration_seconds: duration_seconds || null,
            });
        } else if (type === 'conversion') {
            await supabase.from('conversions').insert({
                site_id:          req.siteId,
                conversion_type:  conversion_type || 'booking',
                conversion_value: conversion_value || null,
                revenue:          conversion_value || null,
                booking_id:       booking_id || null,
                customer_email:   customer_email || null,
                customer_name:    customer_name || null,
                utm_source:       utm_source || null,
                utm_medium:       utm_medium || null,
                utm_campaign:     utm_campaign || null,
                referrer:         referrer || null,
                session_id:       session_id || null,
            });
        }
        res.json({ ok: true });
    } catch(e) {
        res.json({ ok: true }); // never block the page
    }
});

// ============================================
// POST /api/public/events — Session event tracking (clicks, scrolls, etc)
// ============================================
router.post('/events', async (req, res) => {
    const { events } = req.body; // accepts array of events
    if (!events || !events.length) return res.json({ ok: true });
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
    const rows = events.map(e => ({
        site_id:     req.siteId,
        session_id:  e.session_id || null,
        event_type:  e.event_type || 'unknown',
        event_label: e.event_label || null,
        metadata:    e.metadata || null,
        page_path:   e.page_path || '/',
        duration_ms: e.duration_ms || null,
        device_type: e.device_type || null,
        ip_address:  ip,
    }));
    try {
        await supabase.from('session_events').insert(rows);
    } catch(e) { /* non-blocking */ }
    res.json({ ok: true });
});

// ============================================
// POST /api/public/funnel — Booking funnel step tracking
// ============================================
router.post('/funnel', async (req, res) => {
    const { session_id, booking_ref, step, step_name, metadata, time_on_step_ms, device_type } = req.body;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
    try {
        await supabase.from('booking_funnel').insert({
            site_id:         req.siteId,
            session_id:      session_id || null,
            booking_ref:     booking_ref || null,
            step:            step || null,
            step_name:       step_name || null,
            metadata:        metadata || null,
            time_on_step_ms: time_on_step_ms || null,
            device_type:     device_type || null,
            ip_address:      ip,
        });
    } catch(e) { /* non-blocking */ }
    res.json({ ok: true });
});

// ============================================
// POST /api/public/contact — Submit contact form
// ============================================
router.post('/contact', async (req, res) => {
    const { name, email, phone, message } = req.body;

    if (!name || !message) {
        return res.status(400).json({ error: 'Name and message required' });
    }

    // Store as notification for business owner
    await supabase.from('notifications').insert({
        site_id: req.siteId,
        type: 'contact_form',
        title: `New message from ${name}`,
        body: message,
        metadata: { name, email, phone }
    });

    // Send email + SMS to owner
    try {
        const { sendSms } = require('../utils/sms');
        const { sendEmail } = require('../utils/email');
        const [{ data: msgSettingsData }, { data: siteContent }, { data: business }] = await Promise.all([
            supabase.from('messaging_settings').select('*').eq('site_id', req.siteId).maybeSingle(),
            supabase.from('site_content').select('contact_phone, contact_email').eq('site_id', req.siteId).maybeSingle(),
            supabase.from('businesses').select('name, email').eq('site_id', req.siteId).single(),
        ]);
        const settings = msgSettingsData || {};
        // Admin SMS (platform owner) — always fires on contact form submission
        const adminPhone = process.env.ADMIN_SMS_NUMBER;
        if (adminPhone) {
            const bizName = business?.name || 'Client';
            const interest = req.body.interest ? ` | ${req.body.interest}` : '';
            const adminSmsBody = `[${bizName}] NEW CONTACT\n${name} · ${phone || 'no phone'}${interest}\n${email || 'no email'}\n"${message.slice(0, 200)}"`;
            sendSms(adminPhone, adminSmsBody, req.siteId, 'contact_form_notify').catch(() => {});
        }

        // Customer confirmation SMS — gated on customer's explicit consent checkbox
        if (phone && req.body.sms_consent === true) {
            const businessName2 = business?.name || 'us';
            const customerSms = `Hi ${name}! We received your message and will get back to you shortly. Thanks for contacting ${businessName2}! Reply STOP to opt out.`;
            sendSms(phone, customerSms, req.siteId, 'contact_form_confirm').catch(() => {});
        }
        // Collect all emails: primary, secondary (CC), contact_email, business email
        const emailList = [];
        if (settings?.notification_email) emailList.push(settings.notification_email);
        if (settings?.notification_email_2) emailList.push(settings.notification_email_2);
        if (!settings?.notification_email && !settings?.notification_email_2) {
          // Fallback to contact_email or business email if no notification emails set
          if (siteContent?.contact_email) emailList.push(siteContent.contact_email);
          else if (business?.email) emailList.push(business.email);
        }
        const ownerEmail = emailList.length ? emailList : null;
        console.log('[contact] siteId:', req.siteId, '| notification_emails:', { primary: settings?.notification_email, secondary: settings?.notification_email_2 }, '| recipients:', ownerEmail);
        const businessName = business?.name || 'Us';
        const interestHtml = req.body.interest ? `<p><strong>Interested in:</strong> ${req.body.interest}</p>` : '';

        // Owner email
        if (ownerEmail && ownerEmail.length) {
            const emailResult = await sendEmail({
                to: ownerEmail,
                subject: `New Contact Form Message from ${name}`,
                html: `<p><strong>From:</strong> ${name}</p>${phone ? `<p><strong>Phone:</strong> ${phone}</p>` : ''}${email ? `<p><strong>Email:</strong> ${email}</p>` : ''}${interestHtml}<p><strong>Message:</strong></p><p>${message.replace(/\n/g, '<br>')}</p>`,
                replyTo: email || undefined
            });
            console.log('[contact] owner email result:', JSON.stringify(emailResult));
        } else {
            console.log('[contact] no owner email found, skipping owner email');
        }

        // Customer confirmation email
        if (email) {
            const customerResult = await sendEmail({
                to: email,
                subject: `We got your message — ${businessName}`,
                html: `<p>Hi <strong>${name}</strong>,</p>
<p>Thanks for reaching out to <strong>${businessName}</strong>! We received your message and will get back to you as soon as possible.</p>
${interestHtml}
<p><strong>Your message:</strong></p>
<p style="background:#f9fafb;padding:12px;border-radius:8px;border-left:3px solid #00ada8;">${message.replace(/\n/g, '<br>')}</p>
<p>Best regards,<br><strong>${businessName}</strong></p>`,
                replyTo: ownerEmail ? ownerEmail[0] : undefined
            });
            console.log('[contact] customer email result:', JSON.stringify(customerResult));
        }
    } catch(e) { console.error('[contact] error:', e.message); }

    res.json({ success: true, message: 'Message sent!' });
});

// ============================================
// POST /api/public/chat — Tourist AI chat (Grok) or business public chat
// Accepts: { session_id, message } for tourist sessions
//          { site_id, message, conversation_id } for business page chatbots
// ============================================
router.post('/chat', async (req, res) => {
    const { message, session_id, site_id, conversation_id } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message required' });
    }

    // ---- Tourist session chat (Grok) ----
    if (session_id) {
        const { data: session } = await supabase
            .from('tourist_sessions')
            .select('*')
            .eq('session_id', session_id)
            .single();

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Load conversation history
        const { data: history } = await supabase
            .from('tourist_conversations')
            .select('role, content')
            .eq('session_id', session.id)
            .order('created_at', { ascending: true })
            .limit(20);

        // Load relevant businesses based on interests
        let businessContext = '';
        const interests = session.interests || [];
        if (interests.length > 0) {
            const categoryMap = {
                'food': 'restaurants', 'dining': 'restaurants', 'restaurants': 'restaurants',
                'boats': 'things-to-do', 'rentals': 'things-to-do', 'activities': 'things-to-do',
                'nightlife': 'nightlife', 'bars': 'nightlife',
                'shopping': 'shopping', 'coffee': 'coffee-sweets'
            };
            const types = [...new Set(interests.map(i => categoryMap[i.toLowerCase()] || 'other'))];
            const { data: bizList } = await supabase
                .from('businesses')
                .select('name, type, site_content(city, state, address, contact_phone, seo_description, hours)')
                .eq('status', 'active')
                .eq('gcr_listed', true)
                .in('type', types)
                .limit(15);

            if (bizList && bizList.length > 0) {
                businessContext = '\n\nLocal businesses:\n' + bizList.map(b => {
                    const c = b.site_content || {};
                    return `- ${b.name} (${b.type}): ${c.seo_description || ''} | ${c.address || ''} | ${c.contact_phone || ''} | Hours: ${c.hours || 'call ahead'}`;
                }).join('\n');
            }
        }

        const systemPrompt = `You are a friendly Gulf Coast trip assistant for Orange Beach and Gulf Shores, Alabama. You know everything about local restaurants, boat rentals, fishing charters, activities, and events.

Tourist info:
- Name: ${session.name}
- Visitor type: ${session.visitor_type || 'tourist'}
- Interests: ${(session.interests || []).join(', ') || 'general'}
- Trip dates: ${session.checkin || 'unknown'} to ${session.checkout || 'unknown'}
${businessContext}

Be helpful, enthusiastic, and specific. Recommend real places. Keep responses concise and friendly. You can help them plan their trip and point them to the right businesses.`;

        const messages = [
            ...(history || []).map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: message }
        ];

        // Save user message
        await supabase.from('tourist_conversations').insert({
            session_id: session.id,
            role: 'user',
            content: message
        });

        // Call Grok API
        if (!process.env.GROK_API_KEY) {
            return res.json({ reply: "I'm getting set up! Check back soon for personalized Gulf Coast recommendations.", session_id });
        }

        try {
            const grokRes = await fetch('https://api.x.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + process.env.GROK_API_KEY
                },
                body: JSON.stringify({
                    model: 'grok-2-latest',
                    messages: [{ role: 'system', content: systemPrompt }, ...messages],
                    max_tokens: 500,
                    temperature: 0.8
                })
            });
            const grokData = await grokRes.json();
            const reply = grokData.choices?.[0]?.message?.content || "I had trouble getting that. Try asking again!";

            // Save assistant response
            await supabase.from('tourist_conversations').insert({
                session_id: session.id,
                role: 'assistant',
                content: reply
            });

            return res.json({ reply, session_id });
        } catch (err) {
            console.error('Grok error:', err.message);
            return res.status(500).json({ error: 'AI service error', session_id });
        }
    }

    // ---- Business page AI agent (function calling) ----
    if (!site_id) {
        return res.json({ reply: "Thanks for your message! Please call us directly or use our booking form." });
    }

    if (!process.env.OPENAI_API_KEY) {
        return res.json({ reply: "Our assistant is being set up — please call us directly!" });
    }

    const history = req.body.history || [];

    // Resolve site_id (could be subdomain string or UUID)
    let siteQuery = supabase.from('businesses').select('id, name, type, subdomain, tagline');
    if (site_id.length > 30) siteQuery = siteQuery.eq('id', site_id);
    else siteQuery = siteQuery.eq('subdomain', site_id);
    const { data: biz } = await siteQuery.single();

    if (!biz) return res.json({ reply: "Sorry, I couldn't find this business." });

    // Load ALL business data for context — the AI should know everything the website knows
    const [contentRes, servicesRes, fleetRes, faqRes, reviewsRes, detailsRes, logisticsRes, atmosphereRes] = await Promise.all([
        supabase.from('site_content').select('contact_phone, address, city, hours, hours_note, description, website_url').eq('site_id', biz.id).maybeSingle(),
        supabase.from('services').select('id, name, price, duration, description, whats_included').eq('site_id', biz.id).eq('active', true),
        supabase.from('fleet_types').select('id, name, capacity, price_per_hour, quantity, description').eq('site_id', biz.id),
        supabase.from('qa_pairs').select('question, answer, category').eq('site_id', biz.id).limit(30),
        supabase.from('reviews').select('rating, comment, customer_name').eq('site_id', biz.id).order('created_at', { ascending: false }).limit(5),
        supabase.from('business_details').select('*').eq('site_id', biz.id).maybeSingle(),
        supabase.from('business_logistics').select('*').eq('site_id', biz.id).maybeSingle(),
        supabase.from('business_atmosphere').select('*').eq('site_id', biz.id).maybeSingle()
    ]);

    const c = contentRes.data || {};
    const details = detailsRes.data || {};
    const logistics = logisticsRes.data || {};
    const atmo = atmosphereRes.data || {};

    let ctx = `BUSINESS: ${biz.name}\nType: ${biz.type}\nTagline: ${biz.tagline || ''}`;
    if (c.address) ctx += `\nAddress: ${c.address}, ${c.city || ''}`;
    if (c.contact_phone) ctx += `\nPhone: ${c.contact_phone}`;
    if (c.hours) ctx += `\nHours: ${c.hours}`;
    if (c.hours_note) ctx += ` (${c.hours_note})`;
    if (c.description) ctx += `\nAbout: ${c.description}`;
    if (c.website_url) ctx += `\nWebsite: ${c.website_url}`;

    // Business personality & insider info
    if (details.elevator_pitch || details.vibe_description || details.who_its_for) {
        ctx += '\n\nABOUT THIS PLACE:';
        if (details.elevator_pitch) ctx += `\n${details.elevator_pitch}`;
        if (details.vibe_description) ctx += `\nVibe: ${details.vibe_description}`;
        if (details.who_its_for) ctx += `\nBest for: ${details.who_its_for}`;
        if (details.what_to_expect) ctx += `\nWhat to expect: ${details.what_to_expect}`;
        if (details.signature_dish) ctx += `\nSignature dish: ${details.signature_dish}`;
        if (details.signature_drink) ctx += `\nSignature drink: ${details.signature_drink}`;
        if (details.must_try && details.must_try.length) ctx += `\nMust try: ${details.must_try.join(', ')}`;
        if (details.insider_tip) ctx += `\nInsider tip: ${details.insider_tip}`;
        if (details.pro_tip) ctx += `\nPro tip: ${details.pro_tip}`;
        if (details.best_time_of_day) ctx += `\nBest time to visit: ${details.best_time_of_day}`;
        if (details.avg_wait_time) ctx += `\nTypical wait: ${details.avg_wait_time}`;
        if (details.avg_visit_duration) ctx += `\nTypical visit: ${details.avg_visit_duration}`;
        if (details.years_in_business) ctx += `\nIn business ${details.years_in_business} years`;
        if (details.owner_name) ctx += `\nOwner: ${details.owner_name}`;
        if (details.awards && details.awards.length) ctx += `\nAwards: ${details.awards.join(', ')}`;
    }

    // Logistics — parking, accessibility, directions
    if (logistics.parking_type || logistics.directions_note || logistics.wheelchair_accessible !== undefined) {
        ctx += '\n\nGETTING HERE & ACCESS:';
        if (logistics.parking_type) ctx += `\nParking: ${logistics.parking_type}${logistics.parking_notes ? ' — ' + logistics.parking_notes : ''}`;
        if (logistics.parking_lot_size) ctx += ` (${logistics.parking_lot_size} lot)`;
        if (logistics.directions_note) ctx += `\nDirections: ${logistics.directions_note}`;
        if (logistics.landmark) ctx += `\nLandmark: ${logistics.landmark}`;
        if (logistics.distance_from_beach) ctx += `\nDistance from beach: ${logistics.distance_from_beach}`;
        if (logistics.distance_from_wharf) ctx += `\nDistance from The Wharf: ${logistics.distance_from_wharf}`;
        if (logistics.wheelchair_accessible) ctx += `\nWheelchair accessible: Yes`;
        if (logistics.stroller_friendly) ctx += `\nStroller friendly: Yes`;
        if (logistics.waterfront_access) ctx += `\nWaterfront access: Yes`;
        if (logistics.dock_available) ctx += `\nDock available: Yes`;
        if (logistics.boat_accessible) ctx += `\nBoat accessible: Yes`;
        if (logistics.golf_cart_parking) ctx += `\nGolf cart parking: Yes`;
        if (logistics.reservations) ctx += `\nReservations: ${logistics.reservations}`;
    }

    // Atmosphere
    if (atmo.noise_level || atmo.dress_code || atmo.live_music) {
        ctx += '\n\nATMOSPHERE:';
        if (atmo.noise_level) ctx += `\nNoise level: ${atmo.noise_level}`;
        if (atmo.dress_code) ctx += `\nDress code: ${atmo.dress_code}`;
        if (atmo.seating_types && atmo.seating_types.length) ctx += `\nSeating: ${atmo.seating_types.join(', ')}`;
        if (atmo.live_music) ctx += `\nLive music: Yes${atmo.live_music_schedule ? ' — ' + atmo.live_music_schedule : ''}${atmo.live_music_genre ? ' (' + atmo.live_music_genre + ')' : ''}`;
        if (atmo.outdoor_seating) ctx += `\nOutdoor seating: Yes${atmo.covered_outdoor ? ' (covered)' : ''}`;
        if (atmo.ocean_view) ctx += `\nOcean view: Yes`;
        if (atmo.bay_view) ctx += `\nBay view: Yes`;
        if (atmo.sunset_view) ctx += `\nSunset view: Yes`;
        if (atmo.wifi) ctx += `\nFree WiFi: Yes`;
        if (atmo.sports_tv) ctx += `\nSports TVs: Yes`;
        if (atmo.trivia_night) ctx += `\nTrivia night: ${atmo.trivia_night}`;
        if (atmo.karaoke) ctx += `\nKaraoke: Yes`;
        if (atmo.fire_pit) ctx += `\nFire pit: Yes`;
        if (atmo.arcade_games) ctx += `\nArcade games: Yes`;
        if (atmo.pool_table) ctx += `\nPool table: Yes`;
    }

    if ((servicesRes.data || []).length) {
        ctx += '\n\nSERVICES/PACKAGES:';
        servicesRes.data.forEach(s => {
            ctx += `\n- ${s.name} (id: ${s.id}): $${s.price}${s.duration ? ' (' + s.duration + ' min)' : ''}`;
            if (s.description) ctx += ` — ${s.description}`;
            if (s.whats_included) ctx += ` | Includes: ${s.whats_included}`;
        });
    }

    if ((fleetRes.data || []).length) {
        ctx += '\n\nFLEET/RENTALS:';
        fleetRes.data.forEach(f => {
            ctx += `\n- ${f.name} (id: ${f.id}): $${f.price_per_hour}/hr, fits ${f.capacity} people, ${f.quantity} available`;
            if (f.description) ctx += ` — ${f.description}`;
        });
    }

    if ((faqRes.data || []).length) {
        ctx += '\n\nFAQs:';
        faqRes.data.forEach(q => { ctx += `\nQ: ${q.question}\nA: ${q.answer}`; });
    }

    if ((reviewsRes.data || []).length) {
        const avg = (reviewsRes.data.reduce((s, r) => s + r.rating, 0) / reviewsRes.data.length).toFixed(1);
        ctx += `\n\nREVIEWS (avg ${avg} stars):`;
        reviewsRes.data.forEach(r => { ctx += `\n- ${r.rating}★ ${r.customer_name || ''}: "${(r.comment || '').slice(0, 80)}"`; });
    }

    // ── OpenAI Function Calling tools ──
    const tools = [
        {
            type: 'function',
            function: {
                name: 'check_availability',
                description: 'Check what boats/rentals are available on a specific date. Call this when a customer mentions a date or asks about availability.',
                parameters: {
                    type: 'object',
                    properties: {
                        date: { type: 'string', description: 'Date in YYYY-MM-DD format' }
                    },
                    required: ['date']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'create_booking_hold',
                description: 'Reserve a spot for 10 minutes while the customer confirms. Call this after the customer confirms date, fleet type, and time slot.',
                parameters: {
                    type: 'object',
                    properties: {
                        fleet_type_id: { type: 'string', description: 'UUID of the fleet type' },
                        time_slot_id: { type: 'string', description: 'UUID of the time slot' },
                        booking_date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
                        qty: { type: 'integer', description: 'Number of boats/units', default: 1 }
                    },
                    required: ['fleet_type_id', 'time_slot_id', 'booking_date']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'create_booking',
                description: 'Finalize a booking after collecting customer name, phone/email, and confirming details. This creates the actual booking and sends SMS confirmation.',
                parameters: {
                    type: 'object',
                    properties: {
                        fleet_type_id: { type: 'string', description: 'UUID of the fleet type' },
                        time_slot_id: { type: 'string', description: 'UUID of the time slot' },
                        booking_date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
                        qty: { type: 'integer', description: 'Number of boats/units', default: 1 },
                        party_size: { type: 'integer', description: 'Total number of people' },
                        customer_name: { type: 'string', description: 'Customer full name' },
                        customer_phone: { type: 'string', description: 'Customer phone number' },
                        customer_email: { type: 'string', description: 'Customer email (optional)' },
                        notes: { type: 'string', description: 'Any special requests or notes' }
                    },
                    required: ['fleet_type_id', 'time_slot_id', 'booking_date', 'customer_name', 'customer_phone']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'send_sms',
                description: 'Send an SMS message to the customer (e.g. booking link, directions, confirmation details).',
                parameters: {
                    type: 'object',
                    properties: {
                        phone: { type: 'string', description: 'Phone number to send to' },
                        message_text: { type: 'string', description: 'SMS message body' }
                    },
                    required: ['phone', 'message_text']
                }
            }
        }
    ];

    // ── Tool executor ──
    async function executeTool(name, args) {
        switch (name) {
            case 'check_availability': {
                const { date } = args;
                const [bookingsRes, fleetItemsRes, timeSlotsRes, fleetTypesRes, holdsRes, blockedRes] = await Promise.all([
                    supabase.from('bookings').select('fleet_type_id, time_slot_id, qty, status').eq('site_id', biz.id).eq('booking_date', date).in('status', ['pending', 'confirmed', 'checked_in']),
                    supabase.from('fleet_items').select('fleet_type_id, condition').eq('site_id', biz.id).eq('condition', 'good'),
                    supabase.from('rental_time_slots').select('id, name, start_time, end_time').eq('site_id', biz.id).eq('active', true),
                    supabase.from('fleet_types').select('id, name, capacity, price_per_hour').eq('site_id', biz.id).eq('available', true),
                    supabase.from('booking_holds').select('fleet_type_id, time_slot_id, qty').eq('site_id', biz.id).eq('booking_date', date).gt('expires_at', new Date().toISOString()),
                    supabase.from('availability').select('service_id, blocked').eq('site_id', biz.id).eq('specific_date', date).eq('blocked', true)
                ]);

                const inventory = {};
                (fleetItemsRes.data || []).forEach(i => { inventory[i.fleet_type_id] = (inventory[i.fleet_type_id] || 0) + 1; });

                const booked = {};
                const bookedNoSlot = {};
                (bookingsRes.data || []).forEach(b => {
                    if (b.time_slot_id) {
                        const key = `${b.fleet_type_id}_${b.time_slot_id}`;
                        booked[key] = (booked[key] || 0) + (b.qty || 1);
                    } else {
                        bookedNoSlot[b.fleet_type_id] = (bookedNoSlot[b.fleet_type_id] || 0) + (b.qty || 1);
                    }
                });
                (holdsRes.data || []).forEach(h => {
                    if (h.time_slot_id) {
                        const key = `${h.fleet_type_id}_${h.time_slot_id}`;
                        booked[key] = (booked[key] || 0) + (h.qty || 1);
                    } else {
                        bookedNoSlot[h.fleet_type_id] = (bookedNoSlot[h.fleet_type_id] || 0) + (h.qty || 1);
                    }
                });

                const blockedSet = new Set((blockedRes.data || []).map(b => b.service_id));
                const availability = [];
                (fleetTypesRes.data || []).forEach(ft => {
                    (timeSlotsRes.data || []).forEach(ts => {
                        const key = `${ft.id}_${ts.id}`;
                        const total = inventory[ft.id] || 0;
                        const used = (booked[key] || 0) + (bookedNoSlot[ft.id] || 0);
                        const remaining = Math.max(0, total - used);
                        if (!blockedSet.has(ft.id)) {
                            availability.push({
                                fleet_type_id: ft.id, fleet_type_name: ft.name,
                                time_slot_id: ts.id, time_slot_name: ts.name,
                                start_time: ts.start_time, end_time: ts.end_time,
                                price_per_hour: ft.price_per_hour, capacity: ft.capacity,
                                available: remaining
                            });
                        }
                    });
                });

                return JSON.stringify({ date, availability });
            }

            case 'create_booking_hold': {
                const sessionId = `ai-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const { data, error } = await supabase.rpc('create_booking_hold', {
                    p_site_id: biz.id,
                    p_fleet_type_id: args.fleet_type_id,
                    p_time_slot_id: args.time_slot_id,
                    p_booking_date: args.booking_date,
                    p_qty: args.qty || 1,
                    p_session_id: sessionId
                });
                if (error) return JSON.stringify({ success: false, error: error.message });
                return JSON.stringify({ ...data, session_id: sessionId });
            }

            case 'create_booking': {
                const sessionId = `ai-book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

                // Look up fleet type for pricing
                const { data: ft } = await supabase.from('fleet_types').select('price_per_hour, name').eq('id', args.fleet_type_id).single();
                const price = ft?.price_per_hour || 0;
                const qty = args.qty || 1;
                const subtotal = price * qty;
                const tax = Math.round(subtotal * 0.1 * 100) / 100; // 10% tax estimate
                const total = subtotal + tax;

                // Upsert customer
                let customerId = null;
                if (args.customer_email) {
                    const { data: existing } = await supabase.from('customers').select('id').eq('site_id', biz.id).eq('email', args.customer_email).single();
                    if (existing) {
                        customerId = existing.id;
                    } else {
                        const { data: newCust } = await supabase.from('customers').insert({
                            site_id: biz.id, name: args.customer_name, phone: args.customer_phone,
                            email: args.customer_email, total_bookings: 1, total_spent: total
                        }).select('id').single();
                        if (newCust) customerId = newCust.id;
                    }
                } else if (args.customer_phone) {
                    const { data: existing } = await supabase.from('customers').select('id').eq('site_id', biz.id).eq('phone', args.customer_phone).single();
                    if (existing) {
                        customerId = existing.id;
                    } else {
                        const { data: newCust } = await supabase.from('customers').insert({
                            site_id: biz.id, name: args.customer_name, phone: args.customer_phone,
                            total_bookings: 1, total_spent: total
                        }).select('id').single();
                        if (newCust) customerId = newCust.id;
                    }
                }

                // Atomic booking
                const { data: result, error: rpcError } = await supabase.rpc('create_booking_if_available', {
                    p_site_id: biz.id,
                    p_fleet_type_id: args.fleet_type_id,
                    p_time_slot_id: args.time_slot_id,
                    p_booking_date: args.booking_date,
                    p_qty: qty,
                    p_service_id: null,
                    p_booking_time: null,
                    p_party_size: args.party_size || qty * 2,
                    p_addons: '[]',
                    p_subtotal: subtotal,
                    p_tax: tax,
                    p_total: total,
                    p_customer_id: customerId,
                    p_customer_name: args.customer_name,
                    p_customer_phone: args.customer_phone,
                    p_customer_email: args.customer_email || null,
                    p_notes: args.notes || null,
                    p_hold_session_id: null
                });

                if (rpcError) return JSON.stringify({ success: false, error: rpcError.message });
                if (!result.success) return JSON.stringify({ success: false, error: result.error, available: result.available });

                // Send confirmation SMS (non-blocking)
                try {
                    const { sendSms, fillTemplate, buildTemplateData } = require('../utils/sms');
                    const { data: fullBooking } = await supabase.from('bookings').select().eq('id', result.booking_id).single();
                    const { data: siteContent } = await supabase.from('site_content').select('messaging_settings, contact_phone').eq('site_id', biz.id).single();
                    const settings = siteContent?.messaging_settings || {};
                    const templateData = await buildTemplateData(fullBooking, biz.id);

                    if (args.customer_phone) {
                        const tpl = '[{{business_name}}] Hi {{customer_name}}! Your booking is confirmed.\n\nDate: {{date}}\nTime: {{time_slot}}\nTotal: ${{total}}\n\nQuestions? Reply to this number!\n\n🏖️ Get exclusive deals & rewards while you\'re in town!\nSign up for Gulf Coast Radar Trip Pass:\ngulfcoastradar.com/trip-pass';
                        const msg = fillTemplate(settings.customerBookingTemplate || tpl, templateData);
                        sendSms(args.customer_phone, msg, biz.id, 'booking_confirmation', result.booking_id).catch(() => {});
                    }
                    if (siteContent?.contact_phone) {
                        const tpl = 'NEW BOOKING (via AI chat)!\n\nCustomer: {{customer_name}}\nPhone: {{customer_phone}}\nDate: {{date}}\nTime: {{time_slot}}\nTotal: ${{total}}';
                        const msg = fillTemplate(settings.ownerBookingTemplate || tpl, templateData);
                        sendSms(siteContent.contact_phone, msg, biz.id, 'booking_owner_notify', result.booking_id).catch(() => {});
                    }
                } catch (smsErr) { console.error('AI booking SMS error:', smsErr); }

                return JSON.stringify({
                    success: true,
                    booking_id: result.booking_id,
                    fleet_type: ft?.name || args.fleet_type_id,
                    date: args.booking_date,
                    customer: args.customer_name,
                    total: total
                });
            }

            case 'send_sms': {
                try {
                    const { sendSms } = require('../utils/sms');
                    await sendSms(args.phone, args.message_text, biz.id, 'ai_chat_sms');
                    return JSON.stringify({ success: true });
                } catch (err) {
                    return JSON.stringify({ success: false, error: err.message });
                }
            }

            default:
                return JSON.stringify({ error: 'Unknown tool' });
        }
    }

    const systemPrompt = `You are the AI assistant for ${biz.name}. You know EVERYTHING about this business — answer any question a customer could possibly ask. You can also check real-time availability, create bookings, and send SMS confirmations.

${ctx}

RULES:
- Be friendly, warm, helpful — like talking to a real person who works here
- Answer ANY question using the data above: hours, pricing, age requirements, restrictions, parking, accessibility, dress code, what to bring, weather tips, directions, vibe, menu, reviews, policies — ANYTHING
- Keep responses short and conversational (2-3 sentences). Be specific, not generic.
- If a customer asks about age restrictions, requirements, rules, policies, safety, etc. — answer from the FAQs and business data. If not covered, say "I'd recommend checking with us directly" and offer to connect them
- YOU handle bookings directly — never tell people to call
- Booking flow:
  1. Customer wants to book → ask what date
  2. Call check_availability to see what's open
  3. Tell them what's available with prices
  4. Customer picks boat/service + time → confirm details
  5. Ask for their name and phone number
  6. Call create_booking to finalize — this sends them an SMS confirmation automatically
- If a date is fully booked, suggest the next available day
- If a slot they want is taken, show alternatives
- Today's date is ${new Date().toISOString().split('T')[0]}
- When customer says relative dates like "Saturday" or "this weekend", convert to YYYY-MM-DD
- You can send_sms to text a customer a booking link, directions, or any info they ask for
- After ANY completed booking, mention: "Check out Gulf Coast Radar for more local deals, live music, and things to do while you're in town! gulfcoastradar.com"
- If someone asks about other things to do in the area, restaurants, entertainment — mention Gulf Coast Radar as the local guide
- If the data above doesn't cover a very specific question, say "Great question! Let me get the right answer for you —" and offer to take their name/number so the owner can follow up`;

    try {
        // Build initial messages
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.slice(-10),
            { role: 'user', content: message }
        ];

        // Tool-calling loop: keep going until the model returns a text response (max 5 rounds)
        let finalReply = null;
        for (let round = 0; round < 5; round++) {
            const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages,
                    tools,
                    tool_choice: 'auto',
                    max_tokens: 400,
                    temperature: 0.7
                })
            });
            const aiData = await openaiRes.json();
            if (!openaiRes.ok) throw new Error(aiData.error?.message || 'OpenAI error');

            const choice = aiData.choices?.[0];
            if (!choice) throw new Error('No response from AI');

            const msg = choice.message;
            messages.push(msg); // add assistant message (with tool_calls or content)

            // If no tool calls, we're done
            if (!msg.tool_calls || msg.tool_calls.length === 0) {
                finalReply = msg.content || "I'm here to help! What would you like to know?";
                break;
            }

            // Execute each tool call and add results
            for (const tc of msg.tool_calls) {
                let toolArgs;
                try { toolArgs = JSON.parse(tc.function.arguments); } catch { toolArgs = {}; }
                console.log(`AI tool call: ${tc.function.name}(${JSON.stringify(toolArgs)})`);

                const result = await executeTool(tc.function.name, toolArgs);
                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: result
                });
            }
        }

        if (!finalReply) finalReply = "I ran into an issue — could you try again?";

        // Check for booking_intent in the reply (backwards compat with frontend)
        let booking_intent = null;
        const bookingMatch = finalReply.match(/\[BOOKING:(.*?)\]/);
        if (bookingMatch) {
            try { booking_intent = JSON.parse(bookingMatch[1]); } catch(e) {}
            finalReply = finalReply.replace(/\[BOOKING:.*?\]/, '').trim();
        }

        const response = { reply: finalReply };
        if (booking_intent) response.booking_intent = booking_intent;
        res.json(response);
    } catch (err) {
        console.error('Business chat error:', err.message);
        res.json({ reply: "Something went wrong — try again!" });
    }
});

// ============================================
// POST /api/public/gcr-chat — GCR voice/text AI search
// Accepts: { message, history: [{role, content}] }
// Uses OpenAI GPT-4o + all Supabase businesses as context
// ============================================
router.post('/gcr-chat', async (req, res) => {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    if (!process.env.OPENAI_API_KEY) {
        return res.json({ reply: "AI is being set up — check back soon!" });
    }

    // Load all GCR businesses with their key details
    const { data: businesses } = await supabase
        .from('businesses')
        .select(`
            name, type, subdomain, tagline, area, tags,
            happy_hour, kids_friendly, pet_friendly, live_music,
            outdoor, alcohol, price_range, rating,
            site_content(contact_phone, address, city, hours, website_url)
        `)
        .eq('gcr_listed', true)
        .eq('status', 'active')
        .order('name');

    // Build compact business context for AI
    const bizContext = (businesses || []).map(b => {
        const c = b.site_content || {};
        const flags = [
            b.happy_hour   === true && 'happy hour',
            b.live_music   === true && 'live music',
            b.kids_friendly === true && 'kid-friendly',
            b.pet_friendly === true && 'pet-friendly',
            b.outdoor      === true && 'outdoor seating',
            b.alcohol      === true && 'full bar',
        ].filter(Boolean).join(', ');
        return `• ${b.name} [${b.type}] ${b.area || ''} — ${b.tagline || ''} | ${flags} | ${b.price_range || ''} | phone: ${c.contact_phone || 'n/a'}`;
    }).join('\n');

    const systemPrompt = `You are a local Gulf Coast expert for Orange Beach and Gulf Shores, Alabama — like a knowledgeable friend who knows every spot. You help tourists and visitors find exactly what they're looking for.

Here are all the local businesses you know:
${bizContext}

Rules:
- Recommend 2-3 specific businesses from the list above that best match the request
- Include the phone number when available so they can call/book
- Keep responses conversational and under 100 words
- If results are too many, ask ONE follow-up question to narrow it down (party size, budget, time)
- Never make up details not in the list
- Be enthusiastic and local — "Flora-Bama is legendary", not just "Flora-Bama is a bar"`;

    try {
        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...history.slice(-6),
                    { role: 'user', content: message }
                ],
                max_tokens: 300,
                temperature: 0.7
            })
        });

        const data = await openaiRes.json();
        if (!openaiRes.ok) throw new Error(data.error?.message || 'OpenAI error');

        const reply = data.choices?.[0]?.message?.content || "I had trouble with that — try rephrasing!";
        res.json({ reply });
    } catch (err) {
        console.error('GCR chat error:', err.message);
        res.status(500).json({ error: 'AI error', reply: "Something went wrong — try again!" });
    }
});



// ============================================
// GET /api/public/waiver — Fetch waiver to sign
// Supports ?token=X (from dashboard link) or falls back to template
// ============================================
router.get('/waiver', async (req, res) => {
    const { token } = req.query;

    // Token-based lookup: link was generated for a specific booking
    if (token) {
        const { data: waiver } = await supabase
            .from('waivers')
            .select('id, waiver_text, customer_name, booking_id, signed_at')
            .eq('id', token)
            .single();

        if (!waiver) return res.status(404).json({ error: 'Waiver link not found or expired' });
        if (waiver.signed_at) return res.status(410).json({ error: 'Waiver already signed' });

        // Fetch the waiver template text if this record has none yet
        let waiverText = waiver.waiver_text;
        if (!waiverText) {
            const { data: tmpl } = await supabase
                .from('waivers')
                .select('waiver_text')
                .eq('site_id', req.siteId)
                .is('booking_id', null)
                .limit(1)
                .single();
            waiverText = tmpl?.waiver_text || '';
        }

        return res.json({
            waiver_text: waiverText,
            customer_name: waiver.customer_name || '',
            booking_id: waiver.booking_id,
            token
        });
    }

    // No token: return generic template for the business
    const { data } = await supabase
        .from('waivers')
        .select('id, waiver_text, customer_name, signed_at')
        .eq('site_id', req.siteId)
        .is('booking_id', null)
        .order('signed_at', { ascending: false })
        .limit(1)
        .single();

    if (!data) return res.status(404).json({ error: 'No waiver template found' });
    res.json({ waiver_text: data.waiver_text, title: data.customer_name || 'Waiver' });
});

// ============================================
// POST /api/public/waiver — Sign waiver
// Body may include token (from link) or booking_id directly
// ============================================
router.post('/waiver', async (req, res) => {
    const { token, booking_id, customer_name, customer_email, signature_data, waiver_text } = req.body;

    if (!customer_name || !signature_data) {
        return res.status(400).json({ error: 'Customer name and signature required' });
    }

    // Token path: update the pre-created waiver record
    if (token) {
        const { data: existing } = await supabase
            .from('waivers')
            .select('id, booking_id, signed_at')
            .eq('id', token)
            .single();

        if (!existing) return res.status(404).json({ error: 'Waiver link not found' });
        if (existing.signed_at) return res.status(410).json({ error: 'Waiver already signed' });

        const { data, error } = await supabase
            .from('waivers')
            .update({
                customer_name,
                customer_email: customer_email || null,
                signature_data,
                waiver_text: waiver_text || null,
                signed_at: new Date().toISOString(),
                signed_at: new Date().toISOString(),
                ip_address: req.ip
            })
            .eq('id', existing.id)
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });

        if (existing.booking_id) {
            await supabase.from('bookings')
                .update({ waiver_signed: true })
                .eq('id', existing.booking_id);
        }

        return res.json({ success: true, waiver_id: data.id });
    }

    // Direct path: insert new waiver row
    const { data, error } = await supabase
        .from('waivers')
        .insert({
            site_id: req.siteId,
            booking_id: booking_id || null,
            customer_name,
            customer_email: customer_email || null,
            signature_data,
            waiver_text: waiver_text || null,
            signed_at: new Date().toISOString(),
            signed_at: new Date().toISOString(),
            ip_address: req.ip
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    if (booking_id) {
        await supabase.from('bookings')
            .update({ waiver_signed: true })
            .eq('id', booking_id)
            .eq('site_id', req.siteId);
    }

    res.status(201).json({ success: true, waiver_id: data.id });
});


// ============================================
// ============================================
// GET /api/public/reviews?token=X — Load review page data (booking + custom questions)
// ============================================
router.get('/reviews-by-token', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    // Find review request by token
    const { data: review } = await supabase
        .from('reviews')
        .select('id, site_id, booking_id, customer_name, customer_email')
        .eq('review_token', token)
        .eq('token_used', false)
        .single();

    if (!review) return res.status(404).json({ error: 'Invalid or expired review link' });

    // Get booking details
    const { data: booking } = await supabase
        .from('bookings')
        .select('id, booking_date, booking_time, party_size, total, notes')
        .eq('id', review.booking_id)
        .single();

    // Get custom review questions for this business
    const { data: questions } = await supabase
        .from('review_questions')
        .select('id, question_text, question_type, display_order')
        .eq('site_id', review.site_id)
        .eq('enabled', true)
        .order('display_order', { ascending: true });

    res.json({
        review_id: review.id,
        booking: booking ? {
            date: booking.booking_date,
            time: booking.booking_time,
            guests: booking.party_size,
            service: booking.notes
        } : null,
        questions: questions || []
    });
});

// ============================================
// POST /api/public/reviews/submit — submit a review (simplified path)
// ============================================
router.post('/reviews/submit', async (req, res) => {
    const { token, rating, review_text, customer_name, customer_email } = req.body;

    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be 1-5' });
    }

    if (token) {
        const { data: review } = await supabase
            .from('reviews')
            .select('id')
            .eq('review_token', token)
            .eq('token_used', false)
            .single();

        if (!review) return res.status(400).json({ error: 'Invalid or expired review link' });

        const { error } = await supabase
            .from('reviews')
            .update({ rating, text: review_text, status: 'pending', token_used: true, submitted_at: new Date().toISOString() })
            .eq('id', review.id);

        if (error) return res.status(500).json({ error: error.message });
        return res.json({ success: true });
    }

    const siteId = req.siteId;
    if (!siteId) return res.status(400).json({ error: 'subdomain required' });

    const { error } = await supabase.from('reviews').insert({
        site_id: siteId,
        customer_name: customer_name || 'Anonymous',
        customer_email: customer_email || null,
        rating,
        text: review_text,
        status: 'pending',
        submitted_at: new Date().toISOString()
    });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ============================================
// POST /api/public/review — Submit review (with token support & photo uploads)
// ============================================
router.post('/review', async (req, res) => {
    const { token, rating, review_text, review_method } = req.body;
    let reviewId, siteId, bookingId, customerName, customerEmail, customerPhone, ownerPhone;
    const uploadedPhotos = [];

    // If token provided: verify & load review metadata
    if (token) {
        const { data: review } = await supabase
            .from('reviews')
            .select('id, site_id, booking_id, customer_name, customer_email, phone')
            .eq('review_token', token)
            .eq('token_used', false)
            .single();

        if (!review) return res.status(400).json({ error: 'Invalid or expired review link' });

        reviewId = review.id;
        siteId = review.site_id;
        bookingId = review.booking_id;
        customerName = review.customer_name;
        customerEmail = review.customer_email;
        customerPhone = review.phone;
    } else {
        customerName = req.body.customer_name || 'Anonymous';
        customerEmail = req.body.customer_email || null;
        siteId = req.siteId;
    }

    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be 1-5' });
    }

    // Get owner phone for SMS notification
    try {
        const { data: content } = await supabase
            .from('site_content')
            .select('owner_phone')
            .eq('site_id', siteId)
            .single();
        ownerPhone = content?.owner_phone;
    } catch (e) {
        console.warn('Could not fetch owner phone:', e.message);
    }

    // Handle photo uploads
    if (req.files && Array.isArray(req.files)) {
        for (const file of req.files) {
            try {
                const fileName = `${siteId}/${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${file.originalname}`;
                const { data, error: uploadErr } = await supabase.storage
                    .from('review-photos')
                    .upload(fileName, file.buffer, { contentType: file.mimetype });

                if (uploadErr) throw uploadErr;

                const { data: { publicUrl } } = supabase.storage
                    .from('review-photos')
                    .getPublicUrl(fileName);

                uploadedPhotos.push(publicUrl);
            } catch (e) {
                console.warn('Failed to upload photo:', e.message);
            }
        }
    }

    // If token-based, update existing review; otherwise insert new
    let error, newReviewId;
    if (token && reviewId) {
        // Update review with token
        const { error: updateErr } = await supabase
            .from('reviews')
            .update({
                rating,
                text: review_text,
                review_method: review_method || 'text',
                original_voice_text: review_method === 'voice' ? review_text : null,
                photos: uploadedPhotos,
                status: 'pending',
                token_used: true,
                submitted_at: new Date().toISOString()
            })
            .eq('id', reviewId);
        error = updateErr;
        newReviewId = reviewId;
    } else {
        // Insert new review
        const { data: inserted, error: insertErr } = await supabase
            .from('reviews')
            .insert({
                site_id: siteId,
                customer_name: customerName,
                customer_email: customerEmail,
                phone: customerPhone,
                rating,
                text: review_text,
                review_method: review_method || 'text',
                original_voice_text: review_method === 'voice' ? review_text : null,
                photos: uploadedPhotos,
                booking_id: bookingId || null,
                status: 'pending',
                submitted_at: new Date().toISOString()
            })
            .select();
        error = insertErr;
        if (inserted && inserted.length > 0) {
            newReviewId = inserted[0].id;
        }
    }

    if (error) return res.status(500).json({ error: error.message });

    // Store custom question answers (parse from FormData)
    const questionAnswers = [];
    for (const key in req.body) {
        if (key.startsWith('question_')) {
            const qId = key.replace('question_', '');
            questionAnswers.push({
                review_id: newReviewId,
                question_id: qId,
                answer: String(req.body[key])
            });
        }
    }

    if (questionAnswers.length > 0) {
        await supabase.from('review_answers').insert(questionAnswers).catch(e => {
            console.warn('Could not store question answers:', e.message);
        });
    }

    // Send SMS to owner if they have a phone number (non-blocking)
    if (ownerPhone && process.env.TWILIO_ACCOUNT_SID) {
        try {
            const smsBody = `New review from ${customerName}! ⭐${rating} ${uploadedPhotos.length > 0 ? '+ photos' : ''} — Check dashboard to approve.`;
            // TODO: Use internal SMS service or queue to avoid blocking response
            // For now, fire-and-forget to Twilio (production should use async job queue)
            sendSmsAsync(ownerPhone, smsBody).catch(e => console.warn('SMS send failed:', e.message));
        } catch (e) {
            console.warn('Could not send owner SMS:', e.message);
        }
    }

    res.status(201).json({ success: true, message: 'Thank you! Your review has been submitted.' });
});

// ============================================
// GET /api/public/loyalty/balance — Check loyalty balance by email or phone
// MUST be before /loyalty/:email to prevent route collision
// ============================================
router.get('/loyalty/balance', async (req, res) => {
    const { email, phone } = req.query;
    if (!email && !phone) return res.status(400).json({ error: 'email or phone query param required' });

    let query = supabase
        .from('customers')
        .select('name, total_bookings, total_spent, tags')
        .eq('site_id', req.siteId);

    if (email) query = query.eq('email', email);
    else query = query.eq('phone', phone);

    const { data: customer } = await query.maybeSingle();

    if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({
        name: customer.name,
        total_bookings: customer.total_bookings,
        total_spent: customer.total_spent,
        points: Math.floor(customer.total_spent || 0)
    });
});

// ============================================
// GET /api/public/loyalty/:email — Check loyalty points (legacy)
// ============================================
router.get('/loyalty/:email', async (req, res) => {
    const { data: customer } = await supabase
        .from('customers')
        .select('name, total_bookings, total_spent, tags')
        .eq('site_id', req.siteId)
        .eq('email', req.params.email)
        .single();

    if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({
        name: customer.name,
        total_bookings: customer.total_bookings,
        total_spent: customer.total_spent,
        points: Math.floor(customer.total_spent || 0)
    });
});

// ============================================
// POST /api/public/order — Place order (restaurants)
// ============================================
router.post('/order', async (req, res) => {
    const { items, customer_name, customer_phone, customer_email, notes, pickup_time, order_type } = req.body;

    if (!items || !items.length) {
        return res.status(400).json({ error: 'Items required' });
    }

    // Calculate totals
    const subtotal = items.reduce((sum, item) => sum + (item.price * (item.qty || 1)), 0);
    const tax = Math.round(subtotal * 0.1 * 100) / 100; // 10% tax placeholder
    const total = subtotal + tax;

    const { data, error } = await supabase
        .from('orders')
        .insert({
            site_id: req.siteId,
            items,
            subtotal,
            tax,
            total,
            customer_name,
            customer_phone,
            customer_email,
            notes,
            pickup_time,
            order_type: order_type || 'pickup',
            status: 'pending'
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    // TODO: Emit event: order.created
    res.status(201).json(data);
});



// ============================================
// POST /api/public/loyalty/signup — Enroll customer in loyalty program
// ============================================
router.post('/loyalty/signup', async (req, res) => {
    const { email, name, phone } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }

    const { data: existing } = await supabase
        .from('customers')
        .select('id, name, email, total_bookings, total_spent')
        .eq('site_id', req.siteId)
        .eq('email', email)
        .single();

    if (existing) {
        return res.json({
            success: true,
            message: 'Already enrolled',
            customer_id: existing.id,
            points: Math.floor(existing.total_spent || 0)
        });
    }

    const { data: newCustomer, error } = await supabase
        .from('customers')
        .insert({
            site_id: req.siteId,
            name: name || null,
            email: email,
            phone: phone || null,
            total_bookings: 0,
            total_spent: 0,
            tags: ['loyalty']
        })
        .select('id')
        .single();

    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json({
        success: true,
        message: 'Enrolled in loyalty program',
        customer_id: newCustomer.id,
        points: 0
    });
});

// ============================================
// POST /api/public/loyalty/redeem — Redeem loyalty points
// ============================================
router.post('/loyalty/redeem', async (req, res) => {
    const { email, points_to_redeem } = req.body;

    if (!email || !points_to_redeem) {
        return res.status(400).json({ error: 'email and points_to_redeem required' });
    }

    const { data: customer } = await supabase
        .from('customers')
        .select('id, name, total_spent')
        .eq('site_id', req.siteId)
        .eq('email', email)
        .single();

    if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
    }

    const available = Math.floor(customer.total_spent || 0);
    if (points_to_redeem > available) {
        return res.status(400).json({
            error: 'Insufficient points',
            available: available,
            requested: points_to_redeem
        });
    }

    res.json({
        success: true,
        points_redeemed: points_to_redeem,
        points_remaining: available - points_to_redeem,
        discount_value: points_to_redeem * 0.10
    });
});

// ============================================
// GET /api/public/site-data — Business info for website header/footer
// ============================================
router.get('/site-data', async (req, res) => {
    const { data: content } = await supabase
        .from('site_content')
        .select('hero_text, hero_subtext, contact_phone, contact_email, address, city, state, zip, hours, social_links, logo_url, cover_url, theme_color, seo_title, seo_description')
        .eq('site_id', req.siteId)
        .single();

    const { data: business } = await supabase
        .from('businesses')
        .select('name, type, subdomain')
        .eq('site_id', req.siteId)
        .single();

    res.json({ ...business, ...content });
});

// ============================================
// GET /api/public/locations — Launch locations
// ============================================
router.get('/locations', async (req, res) => {
    const { data: content } = await supabase
        .from('site_content')
        .select('address, city, state, zip, lat, lng')
        .eq('site_id', req.siteId)
        .single();

    // Return as an array of locations (single location for now; multi-location support planned)
    res.json([{
        id: 'main',
        name: 'Main Launch',
        address: content?.address || '',
        city: content?.city || '',
        state: content?.state || '',
        zip: content?.zip || '',
        lat: content?.lat || null,
        lng: content?.lng || null,
        is_default: true
    }]);
});

// ============================================
// GET /api/public/docks — Towable dock add-ons
// ============================================
router.get('/docks', async (req, res) => {
    const { data } = await supabase
        .from('rental_addons')
        .select('id, name, description, price, icon, per_unit')
        .eq('site_id', req.siteId)
        .eq('active', true)
        .ilike('category', '%dock%')
        .order('price', { ascending: true });

    res.json(data || []);
});

// ============================================
// GET /api/public/links-page — Linktree-style links page data
// ============================================
router.get('/links-page', async (req, res) => {
    const [{ data: content }, { data: business }, { data: apps }] = await Promise.all([
        supabase.from('site_content')
            .select('social_links, logo_url, hero_text, contact_phone, contact_email, address, city, state, hours, theme_color')
            .eq('site_id', req.siteId).single(),
        supabase.from('businesses')
            .select('name, subdomain, type')
            .eq('site_id', req.siteId).single(),
        supabase.from('site_apps')
            .select('app_id')
            .eq('site_id', req.siteId).eq('enabled', true)
    ]);

    res.json({
        name: business?.name || '',
        subdomain: business?.subdomain || '',
        type: business?.type || '',
        logo_url: content?.logo_url || '',
        tagline: content?.hero_text || '',
        phone: content?.contact_phone || '',
        email: content?.contact_email || '',
        address: content?.address || '',
        city: content?.city || '',
        state: content?.state || '',
        hours: content?.hours || null,
        theme_color: content?.theme_color || '',
        social: content?.social_links || {},
        installed_apps: (apps || []).map(a => a.app_id)
    });
});

// ============================================
// GET /api/public/addons
// ============================================
router.get('/addons', async (req, res) => {
    const { data, error } = await supabase
        .from('rental_addons')
        .select('id, name, description, price, category, icon, per_unit, image_url')
        .eq('site_id', req.siteId)
        .order('category')
        .order('name');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ============================================
// GET /api/public/modules — ordered module list for site template + embed
// ============================================
router.get('/modules', async (req, res) => {
    const { data, error } = await supabase
        .from('site_content')
        .select('modules')
        .eq('site_id', req.siteId)
        .single();

    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
    res.json(data?.modules || null);
});

// ============================================
// POST /api/public/save-section — Save a CMS section (page builder)
// ============================================
router.post('/save-section', async (req, res) => {
    const { section, data } = req.body;
    if (!section || !data) return res.status(400).json({ error: 'section and data required' });

    const updateMap = {
        hero:    { hero_text: data.title, hero_subtext: data.subtitle },
        contact: { contact_phone: data.phone, contact_email: data.email, address: data.address },
        hours:   { hours: typeof data === 'string' ? data : JSON.stringify(data) }
    };

    const updateData = updateMap[section];
    if (!updateData) return res.status(400).json({ error: 'Unknown section: ' + section });

    const { error } = await supabase
        .from('site_content')
        .update({ ...updateData, updated_at: new Date().toISOString() })
        .eq('site_id', req.siteId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ============================================
// POST /api/public/resend-confirmation — Resend booking confirmation SMS + email
// ============================================
router.post('/resend-confirmation', async (req, res) => {
    const { booking_id } = req.body;

    if (!booking_id) {
        return res.status(400).json({ error: 'booking_id required' });
    }

    try {
        const { sendSms, fillTemplate, buildTemplateData } = require('../utils/sms');
        const { sendEmail, customerConfirmationHtml, generateIcsContent } = require('../utils/email');

        // Fetch booking
        const { data: bookingData } = await supabase
            .from('bookings')
            .select('*')
            .eq('id', booking_id)
            .single();

        if (!bookingData) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        // Build template data
        const templateData = await buildTemplateData(bookingData, bookingData.site_id);

        // Resend customer SMS
        if (bookingData.customer_phone) {
            const defaultTpl = '[{{business_name}}] Hi {{customer_name}}! Your booking is confirmed.\n\nDate: {{date}}\nTime: {{time_slot}}\nTotal: ${{total}}\n\nQuestions? Reply to this number!';
            const msg = fillTemplate(defaultTpl, templateData);
            await sendSms(bookingData.customer_phone, msg, bookingData.site_id, 'booking_confirmation', booking_id)
                .catch(err => console.error('Resend SMS failed:', err));
        }

        // Resend customer email
        if (bookingData.customer_email) {
            const attachments = [{ filename: 'booking.ics', content: Buffer.from(generateIcsContent(templateData)).toString('base64') }];

            // ── Fetch waiver if booking has one ──
            try {
                const { data: waiver, error: waiverError } = await supabase
                    .from('signed_waivers')
                    .select('id, waiver_pdf_url, signed_at, signature')
                    .eq('booking_id', booking_id)
                    .maybeSingle();

                if (waiver && !waiverError) {
                    templateData.waiver_acknowledgment = true;
                    templateData.waiver_pdf = waiver.waiver_pdf_url;

                    // ── Attach waiver PDF if available ──
                    if (waiver.waiver_pdf_url) {
                        try {
                            const waiverResponse = await fetch(waiver.waiver_pdf_url);
                            if (waiverResponse.ok) {
                                const waiverBuffer = await waiverResponse.arrayBuffer();
                                attachments.push({
                                    filename: 'waiver-agreement.pdf',
                                    content: Buffer.from(waiverBuffer).toString('base64')
                                });
                            }
                        } catch (err) {
                            console.warn('Could not fetch waiver PDF:', err.message);
                        }
                    }
                }
            } catch (err) {
                console.warn('Waiver fetch error (continuing with email):', err.message);
            }

            await sendEmail({
                to: bookingData.customer_email,
                subject: 'Booking Confirmed — ' + (templateData.business_name || 'Your Reservation'),
                html: customerConfirmationHtml(templateData),
                attachments: attachments
            }).catch(err => console.error('Resend email failed:', err));
        }

        // Resend owner/CC notification emails
        const { ownerNotificationHtml } = require('../utils/email');
        const { data: siteContentData } = await supabase
            .from('site_content')
            .select('messaging_settings, contact_email')
            .eq('site_id', bookingData.site_id)
            .maybeSingle();
        const { data: business } = await supabase
            .from('businesses')
            .select('name, email')
            .eq('site_id', bookingData.site_id)
            .maybeSingle();

        const msgSettings = siteContentData?.messaging_settings || {};
        const emailList = [];
        if (msgSettings.notification_email) emailList.push(msgSettings.notification_email);
        if (msgSettings.notification_email_2) emailList.push(msgSettings.notification_email_2);
        if (!emailList.length) {
            if (siteContentData?.contact_email) emailList.push(siteContentData.contact_email);
            else if (business?.email) emailList.push(business.email);
        }
        if (emailList.length) {
            await sendEmail({
                to: emailList,
                subject: 'Booking Confirmed — ' + (templateData.customer_name || 'Customer') + ' · ' + templateData.date,
                html: ownerNotificationHtml(templateData),
                replyTo: bookingData.customer_email || undefined
            }).catch(err => console.error('Resend owner email failed:', err));
        }

        res.json({ success: true, message: 'Confirmations resent to customer' });
    } catch (err) {
        console.error('Resend confirmation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// GET /api/payment-config (public, requireSite)
// Returns active payment processor config for checkout page
// ============================================
router.get('/payment-config', requireSite, async (req, res) => {
    try {
        const [{ data: processorData }, { data: stripeModeData }, { data: squareAppData }, { data: squareLocData }, { data: squareModeData }] = await Promise.all([
            supabase.from('connections').select('account_name').eq('site_id', req.siteId).eq('provider', 'payment_processor').maybeSingle(),
            supabase.from('connections').select('account_name').eq('site_id', req.siteId).eq('provider', 'stripe_mode').maybeSingle(),
            supabase.from('connections').select('account_name').eq('site_id', req.siteId).eq('provider', 'square_app_id').maybeSingle(),
            supabase.from('connections').select('account_name').eq('site_id', req.siteId).eq('provider', 'square_location_id').maybeSingle(),
            supabase.from('connections').select('account_name').eq('site_id', req.siteId).eq('provider', 'square_mode').maybeSingle()
        ]);

        const processor = processorData?.account_name || 'stripe';
        const stripeMode = stripeModeData?.account_name || 'live';

        // Pick Stripe publishable key based on mode
        let stripePublicKey = null;
        if (stripeMode === 'test') {
            stripePublicKey = process.env.STRIPE_PUBLISHABLE_KEY_TEST || process.env.STRIPE_PUBLISHABLE_KEY || null;
        } else {
            stripePublicKey = process.env.STRIPE_PUBLISHABLE_KEY_LIVE || process.env.STRIPE_PUBLISHABLE_KEY || null;
        }

        const feePercent = parseFloat(process.env.SQUARE_PLATFORM_FEE_PERCENT || process.env.PLATFORM_FEE_PERCENT || '1');

        res.json({
            processor,
            stripePublicKey,
            stripeMode,
            squareAppId: squareAppData?.account_name || null,
            squareLocationId: squareLocData?.account_name || null,
            squareMode: squareModeData?.account_name || 'production',
            platformFeePercent: feePercent
        });
    } catch (err) {
        console.error('payment-config error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// GET /api/public/business — Complete business data (menu, events, hours, specials, happy hours)
// ============================================
router.get('/business', async (req, res) => {
    try {
        if (!req.query.slug) {
            return res.status(400).json({ error: 'slug parameter required' });
        }

        // Look up business by slug to get site_id
        const { data: business, error: businessError } = await supabase
            .from('businesses')
            .select('site_id, name, logo_url, cover_url')
            .eq('subdomain', req.query.slug)
            .single();

        if (businessError || !business) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const siteId = business.site_id;

        // Fetch all related data in parallel
        const [menusRes, eventsRes, specialsRes, hoursRes] = await Promise.all([
            supabase.from('menu_items').select('*').eq('site_id', siteId).order('sort_order', { ascending: true }),
            supabase.from('events').select('*').eq('site_id', siteId).order('start_date', { ascending: true }),
            supabase.from('specials').select('*').eq('site_id', siteId).order('created_at', { ascending: false }),
            supabase.from('site_content').select('hours').eq('site_id', siteId).single()
        ]);

        // Group menu items by category
        const categories = {};
        (menusRes.data || []).forEach(item => {
            const cat = item.category || 'Uncategorized';
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push({
                id: item.id,
                name: item.name,
                description: item.description || '',
                price: item.price || 0,
                photo_url: item.photo_url || '',
                image_url: item.image_url || '',
                tags: item.tags || []
            });
        });

        const menuData = Object.entries(categories).map(([name, items]) => ({
            category: name,
            items
        }));

        res.json({
            business: {
                name: business.name,
                logo_url: business.logo_url,
                cover_url: business.cover_url
            },
            menu: menuData,
            events: eventsRes.data || [],
            specials: specialsRes.data || [],
            hours: hoursRes.data?.hours || {}
        });
    } catch (err) {
        console.error('business error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// GET /api/public/menu — Public menu with categories, items, prices, images
// ============================================
router.get('/menu', async (req, res) => {
    try {
        let siteId = req.siteId; // from domain resolution
        const getGcrDb = require('../db');
        const gcrDb = getGcrDb();
        const ENTITY_COLS = 'id, slug, name, hero_image_url, hh_days, hh_start, hh_end, hh_description, live_artist_id, address_line_1, city, state, phone, national_phone, social_instagram, social_facebook, social_tiktok';

        // 1) Direct GCR lookup — ?entity_id=UUID
        if (req.query.entity_id) {
            const { data: ent } = await gcrDb.from('entity').select(ENTITY_COLS).eq('id', req.query.entity_id).maybeSingle();
            if (ent) return await serveMenuFromGcr(res, gcrDb, ent);
            return res.status(404).json({ error: 'Entity not found' });
        }

        // 2) Slug — try GCR entity first, then legacy businesses subdomain
        if (req.query.slug) {
            const { data: ent } = await gcrDb.from('entity').select(ENTITY_COLS).eq('slug', req.query.slug).maybeSingle();
            if (ent) return await serveMenuFromGcr(res, gcrDb, ent);

            const { data: business, error: businessError } = await supabase
                .from('businesses').select('site_id').eq('subdomain', req.query.slug).single();
            if (businessError || !business) return res.status(404).json({ error: 'Business not found' });
            siteId = business.site_id;
        }

        // 3) Direct site_id query param (QR table menu)
        if (!siteId && req.query.site_id) siteId = req.query.site_id;

        if (!siteId) {
            return res.status(400).json({ error: 'No business specified. Use ?slug=xxx, ?entity_id=xxx, or ?site_id=xxx.' });
        }

        // 4) Bridge: site_id → the owner's claimed GCR entity (entity_owners).
        //    entity.legacy_site_id never existed — the slug is the business key.
        try {
            const { data: own } = await gcrDb.from('entity_owners').select('entity_slug').eq('user_id', siteId).maybeSingle();
            if (own && own.entity_slug) {
                const { data: gcrEntity } = await gcrDb.from('entity').select(ENTITY_COLS).eq('slug', own.entity_slug).maybeSingle();
                if (gcrEntity) return await serveMenuFromGcr(res, gcrDb, gcrEntity);
            }
        } catch (_) { /* fall through to legacy DB */ }

        const [{ data: bizData }, { data: siteContent }, { data: items, error }, { data: eventsData }, { data: specialsData }, { data: gcrEntity }] = await Promise.all([
            supabase.from('businesses').select('name, logo_url, tagline, metadata').eq('site_id', siteId).maybeSingle(),
            supabase.from('site_content').select('hours, social_links, address, contact_phone').eq('site_id', siteId).maybeSingle(),
            supabase.from('menu_items').select('*').eq('site_id', siteId)
                .order('sort_order', { ascending: true })
                .order('category', { ascending: true }),
            supabase.from('events').select('*').eq('site_id', siteId).order('event_date', { ascending: true }),
            supabase.from('specials').select('*').eq('site_id', siteId),
            getGcrDb().from('entity_owners').select('entity_slug').eq('user_id', siteId).maybeSingle()
                .then(r => (r.data && r.data.entity_slug)
                    ? getGcrDb().from('entity').select('live_artist_id').eq('slug', r.data.entity_slug).maybeSingle()
                    : { data: null })
                .catch(() => ({ data: null }))
        ]);

        if (error) throw error;

        // Group by item_type then category
        const byType = { food: {}, drink: {}, happy_hour: {} };
        (items || []).forEach(item => {
            const type = ['food', 'drink', 'happy_hour'].includes(item.item_type) ? item.item_type : 'food';
            const cat = item.category || 'Menu Items';
            if (!byType[type][cat]) byType[type][cat] = [];
            byType[type][cat].push({
                id: item.id,
                name: item.name,
                description: item.description || '',
                price: item.price || 0,
                photo_url: item.photo_url || '',
                image_url: item.image_url || '',
                tags: item.tags || [],
                modifiers: item.modifiers || [],
                item_type: type
            });
        });

        const toSections = obj => Object.entries(obj).map(([name, items]) => ({ name, items }));
        const sections = {
            food:        toSections(byType.food),
            drink:       toSections(byType.drink),
            happy_hour:  toSections(byType.happy_hour)
        };
        // backward-compat: menu = food sections with legacy category key
        const menuData = sections.food.map(s => ({ category: s.name, items: s.items }));

        // Get live artist if available via GCR link
        let liveArtist = null;
        if (gcrEntity?.live_artist_id) {
            const { data: artist } = await getGcrDb()
                .from('artist_profiles')
                .select('id, artist_name, slug, bio, photo_url, cashtag, venmo, request_enabled, shoutout_enabled, default_min_request_amount')
                .eq('id', gcrEntity.live_artist_id)
                .eq('is_active', true)
                .maybeSingle()
                .catch(() => ({ data: null }));
            if (artist) liveArtist = artist;
        }

        res.json({
            business_name: bizData ? bizData.name : '',
            logo_url:      bizData ? (bizData.logo_url || '') : '',
            tagline:       bizData?.tagline || '',
            hours:         siteContent?.hours || null,
            social_links:  siteContent?.social_links || null,
            address:       siteContent?.address || '',
            phone:         siteContent?.contact_phone || '',
            sections,
            menu: menuData,
            events:       eventsData || [],
            specials:     specialsData || [],
            hh_schedule:  bizData?.metadata?.hh_schedule || null,
            total_items:  (items || []).length,
            qr_theme:     bizData?.metadata?.qr_theme || null,
            live_artist:  liveArtist,
        });
    } catch (err) {
        console.error('menu error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/public/waivers/send-link — Dashboard: manually send waiver link to customer
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/waivers/send-link', async (req, res) => {
    const { booking_id } = req.body;
    if (!booking_id) return res.status(400).json({ error: 'booking_id required' });

    try {
        const { sendEmail } = require('../utils/email');

        const { data: waiver } = await supabase
            .from('waivers')
            .select('id, customer_name, site_id')
            .eq('booking_id', booking_id)
            .is('signed_at', null)
            .maybeSingle();

        if (!waiver) return res.status(404).json({ error: 'No unsigned waiver found for this booking' });

        const { data: booking } = await supabase
            .from('bookings')
            .select('customer_email, customer_name')
            .eq('id', booking_id)
            .single();

        if (!booking?.customer_email) return res.status(400).json({ error: 'No customer email on file' });

        const { data: biz } = await supabase
            .from('businesses')
            .select('subdomain, custom_domain')
            .eq('site_id', waiver.site_id)
            .maybeSingle();

        const domain = biz?.custom_domain
            || (biz?.subdomain ? `https://${biz.subdomain}.cybercheck.com` : 'https://circle-boats-main.vercel.app');
        const waiverUrl = `${((process.env.PUBLIC_SITE_BASE_URL || domain).trim())}/waiver-form.html?token=${waiver.id}`;

        const name = booking.customer_name || waiver.customer_name || 'there';
        const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr><td style="background:#f59e0b;padding:28px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;">Please Sign Your Waiver</h1>
          <p style="margin:8px 0 0;color:#fef3c7;font-size:14px;">Required before your booking</p>
        </td></tr>
        <tr><td style="padding:32px;text-align:center;">
          <p style="margin:0 0 24px;color:#374151;font-size:15px;">Hi <strong>${name}</strong>, please sign your waiver to complete your booking.</p>
          <a href="${waiverUrl}" style="display:inline-block;background:#f59e0b;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 40px;border-radius:10px;">✍️ Sign Your Waiver →</a>
          <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">This link is unique to your booking. Do not share it.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

        const result = await sendEmail({
            to: booking.customer_email,
            subject: 'Please Sign Your Waiver',
            html
        });

        if (!result.success) return res.status(500).json({ error: result.reason || 'Email failed' });
        res.json({ success: true });
    } catch (err) {
        console.error('send-link error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/public/waivers/send-reminders — Vercel Cron: email waiver link 2 days before booking
// Runs once daily. Secured by CRON_SECRET env var.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/waivers/send-reminders', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers['authorization'] !== 'Bearer ' + secret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { sendEmail } = require('../utils/email');

        // Target: bookings happening exactly 2 days from today (in local date terms)
        const target = new Date();
        target.setDate(target.getDate() + 2);
        const targetDate = target.toISOString().split('T')[0];

        // Find unsigned waivers for bookings on that date
        const { data: waivers, error } = await supabase
            .from('waivers')
            .select('id, token, customer_name, booking_id, site_id')
            .is('signed_at', null);

        if (error) return res.status(500).json({ error: error.message });
        if (!waivers || waivers.length === 0) return res.json({ sent: 0 });

        let sent = 0;
        for (const waiver of waivers) {
            try {
                // Check if booking is on target date
                const { data: booking } = await supabase
                    .from('bookings')
                    .select('customer_email, customer_name, booking_date')
                    .eq('id', waiver.booking_id)
                    .single();

                if (!booking || booking.booking_date !== targetDate) continue;
                if (!booking.customer_email) continue;

                // Get domain from businesses table
                const { data: biz } = await supabase
                    .from('businesses')
                    .select('subdomain, custom_domain')
                    .eq('site_id', waiver.site_id)
                    .maybeSingle();

                const domain = biz?.custom_domain
                    || (biz?.subdomain ? `https://${biz.subdomain}.cybercheck.com` : 'https://circle-boats-main.vercel.app');
                const waiverUrl = `${((process.env.PUBLIC_SITE_BASE_URL || domain).trim())}/waiver-form.html?token=${waiver.id}`;

                const name = booking.customer_name || waiver.customer_name || 'there';
                const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr><td style="background:#0ea5e9;padding:28px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;">Your Booking is in 2 Days!</h1>
          <p style="margin:8px 0 0;color:#e0f2fe;font-size:14px;">Please sign your waiver before you arrive</p>
        </td></tr>
        <tr><td style="padding:32px;text-align:center;">
          <p style="margin:0 0 24px;color:#374151;font-size:15px;">Hi <strong>${name}</strong>, your booking is coming up. Please take a moment to sign your waiver now so check-in is quick and easy.</p>
          <a href="${waiverUrl}" style="display:inline-block;background:#f59e0b;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 40px;border-radius:10px;">✍️ Sign Your Waiver →</a>
          <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;">This link is unique to your booking. Do not share it.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

                await sendEmail({
                    to: booking.customer_email,
                    subject: 'Action Required: Sign Your Waiver Before Your Booking',
                    html
                });

                sent++;
            } catch (err) {
                console.warn('Waiver reminder failed for waiver', waiver.id, err.message);
            }
        }

        res.json({ sent, date: targetDate });
    } catch (err) {
        console.error('waiver send-reminders error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/public/gcr-stats — Live GCR business count for home page display
router.get('/gcr-stats', async (req, res) => {
    try {
        const getGcrDb = require('../db');
        const gcrDb = getGcrDb();
        const { count, error } = await gcrDb
            .from('entity')
            .select('id', { count: 'exact', head: true })
            .eq('is_active', true);
        if (error) throw error;
        res.set('Cache-Control', 'public, max-age=300'); // cache 5 min
        res.json({ live_businesses: count || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/public/ical/:slug/:tokenFile — a business's GCR availability feed (.ics).
// Paste this URL into Airbnb/VRBO/Google Calendar's "import calendar" field so
// GCR-blocked/booked dates auto-block those platforms too. No auth — the token
// in the URL path is the secret (see /api/dashboard/ical/feed-url to mint one).
router.get('/ical/:slug/:tokenFile', async (req, res) => {
    const { slug } = req.params;
    const token = String(req.params.tokenFile || '').replace(/\.ics$/i, '');
    if (!token) return res.status(400).send('Invalid feed token');

    const { data: entity } = await supabase.from('entity').select('slug, name, ical_token').eq('slug', slug).maybeSingle();
    if (!entity || !entity.ical_token || entity.ical_token !== token) {
        return res.status(404).send('Calendar feed not found');
    }

    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 545 * 86400000).toISOString().slice(0, 10); // ~18 months out

    const { data: rows } = await supabase
        .from('business_availability')
        .select('availability_date, status, remaining_spots, booked_count')
        .eq('entity_slug', slug)
        .gte('availability_date', today)
        .lte('availability_date', horizon)
        .order('availability_date');

    const blockedDates = Array.from(new Set(
        (rows || [])
            .filter(r => r.status === 'full' || r.status === 'blocked' || (r.remaining_spots === 0 && (r.booked_count || 0) > 0))
            .map(r => r.availability_date)
    )).sort();

    // Merge consecutive blocked days into single ranges for a cleaner feed
    const ranges = [];
    blockedDates.forEach(d => {
        const last = ranges[ranges.length - 1];
        if (last) {
            const nextDay = new Date(last.to + 'T12:00:00Z');
            nextDay.setUTCDate(nextDay.getUTCDate() + 1);
            if (nextDay.toISOString().slice(0, 10) === d) { last.to = d; return; }
        }
        ranges.push({ from: d, to: d });
    });

    const { generateAvailabilityIcs } = require('../utils/ical-feed');
    const events = ranges.map((r, i) => ({
        uid: `gcr-${slug}-${r.from}-${i}`,
        date_from: r.from,
        date_to: r.to,
        summary: 'Unavailable (Gulf Coast Radar)',
    }));

    const ics = generateAvailabilityIcs(`${entity.name || 'Gulf Coast Radar'} — Availability`, events);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="gcr-availability.ics"');
    res.send(ics);
});

// POST /api/public/business-lead — no auth required, anyone can submit
router.post('/business-lead', async (req, res) => {
    const { business_name, category, contact_name, phone, email, website, notes, plan } = req.body;
    if (!business_name || !email) return res.status(400).json({ error: 'business_name and email required' });
    try {
        await supabase.from('business_leads').insert({
            business_name, category, contact_name, phone, email, website, notes,
            plan: plan || 'Listed',
            status: 'new',
            submitted_at: new Date().toISOString()
        });
        res.json({ success: true });
    } catch(e) {
        // Don't block the user if table doesn't exist yet
        res.json({ success: true });
    }
});

module.exports = router;
