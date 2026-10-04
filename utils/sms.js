const supabase = require('../db');
const telephony = require('../lib/telephony');

/**
 * Send a text and log it to sms_log.
 *
 * Every text goes through lib/telephony (Telnyx by default, Twilio when
 * TELEPHONY_PROVIDER=twilio); nothing here knows which carrier is live.
 *
 * @param {string} to - Phone number
 * @param {string} body - Message text
 * @param {string} siteId - Business site_id (or entity_slug) for logging
 * @param {string} type - 'booking_confirmation', 'booking_owner_notify', 'campaign', 'cancellation'
 * @param {string} relatedId - Optional booking_id or campaign_id
 * @param {string} from - Optional custom from number (overrides the provider's default sender)
 */
async function sendSms(to, body, siteId, type = 'outgoing', relatedId = null, from = null) {
    const ownerPhone = process.env.OWNER_PHONE;
    const relayMode = process.env.OWNER_RELAY_MODE === 'true' && ownerPhone;

    // Owner relay mode: redirect all customer SMS to owner's number for manual forwarding
    if (relayMode) {
        if (!telephony.isConfigured()) {
            console.warn('Relay mode: telephony not configured');
            await logSms(siteId, to, body, type, 'relay_not_configured', relatedId);
            return { success: false, reason: 'telephony_not_configured' };
        }
        const preview = body.length > 280 ? body.substring(0, 280) + '...' : body;
        const relayBody = `📬 RELAY [${type}]\nSEND TO: ${to}\n──────────\n${preview}\n──────────\nCopy # above → text customer`;
        try {
            const msg = await telephony.sendSms({ to: ownerPhone, from: from || undefined, text: relayBody });
            await logSms(siteId, to, body, type, 'relayed_to_owner', relatedId, msg.id, msg.provider);
            return { success: true, relayed: true, sid: msg.id };
        } catch (err) {
            console.error('Owner relay SMS failed:', err.message);
            await logSms(siteId, to, body, type, 'relay_failed', relatedId);
            return { success: false, reason: err.message };
        }
    }

    if (!telephony.isConfigured()) {
        console.warn('Telephony not configured, SMS not sent:', { to, body: body.substring(0, 50) });
        await logSms(siteId, to, body, type, 'not_configured', relatedId);
        return { success: false, reason: 'telephony_not_configured' };
    }

    const normalizedTo = normalizePhone(to);
    if (!normalizedTo) {
        await logSms(siteId, to, body, type, 'invalid_phone', relatedId);
        return { success: false, reason: 'invalid_phone' };
    }

    // Check opt-outs
    const { data: optOut } = await supabase
        .from('sms_opt_outs')
        .select('id')
        .or(`phone.eq.${normalizedTo},phone.eq.${to}`)
        .limit(1)
        .maybeSingle();

    if (optOut) {
        await logSms(siteId, normalizedTo, body, type, 'opted_out', relatedId);
        return { success: false, reason: 'opted_out' };
    }

    try {
        const message = await telephony.sendSms({ to: normalizedTo, from: from || undefined, text: body });
        await logSms(siteId, normalizedTo, body, type, 'sent', relatedId, message.id, message.provider);
        // `sid` kept for callers written against the Twilio-only version.
        return { success: true, sid: message.id, id: message.id, provider: message.provider };
    } catch (err) {
        console.error('SMS send error:', err.message);
        await logSms(siteId, normalizedTo, body, type, 'failed', relatedId);
        return { success: false, reason: err.message };
    }
}

/**
 * Fill template tokens with data
 * Tokens: {{customer_name}}, {{customer_phone}}, {{customer_email}},
 * {{business_name}}, {{date}}, {{time_slot}}, {{boat_count}}, {{boat_type}},
 * {{addons}}, {{guest_count}}, {{total}}, {{location}}, {{payment_status}}
 */
function fillTemplate(template, data) {
    if (!template) return '';
    return template.replace(/\{\{(\w+)\}\}/g, function (match, key) {
        return data[key] !== undefined ? String(data[key]) : match;
    });
}

/**
 * Build template data object from a booking record + business profile
 */
async function buildTemplateData(booking, siteId) {
    // Get business name
    const { data: business } = await supabase
        .from('businesses')
        .select('name')
        .eq('site_id', siteId)
        .single();

    // Get address info
    const { data: content } = await supabase
        .from('site_content')
        .select('address, city, state, zip')
        .eq('site_id', siteId)
        .single();

    // Get fleet type name
    let boatType = '';
    if (booking.fleet_type_id) {
        const { data: fleet } = await supabase
            .from('fleet_types')
            .select('name')
            .eq('id', booking.fleet_type_id)
            .single();
        boatType = fleet?.name || '';
    }

    // Get time slot name
    let timeSlot = booking.booking_time || '';
    if (booking.time_slot_id) {
        const { data: slot } = await supabase
            .from('rental_time_slots')
            .select('name, start_time, end_time')
            .eq('id', booking.time_slot_id)
            .single();
        if (slot) {
            timeSlot = slot.name + ' (' + slot.start_time + ' - ' + slot.end_time + ')';
        }
    }

    // Format addons
    const addons = Array.isArray(booking.addons) && booking.addons.length > 0
        ? booking.addons.map(a => a.name).join(', ')
        : 'None';

    // Format date
    const dateStr = booking.booking_date
        ? new Date(booking.booking_date + 'T12:00:00').toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        })
        : '';

    const location = content
        ? [content.address, content.city, content.state, content.zip].filter(Boolean).join(', ')
        : '';

    // Get tracking data from conversions table
    let utm_source = 'Direct';
    let utm_medium = 'Direct';
    let utm_campaign = '(none)';
    let referrer = 'Direct';
    let device_type = 'Unknown';
    let session_duration_mins = 0;
    let page_source = 'Homepage';

    try {
        const { data: conversion } = await supabase
            .from('conversions')
            .select('utm_source, utm_medium, utm_campaign, referrer, session_id')
            .eq('booking_id', booking.id)
            .maybeSingle();

        if (conversion) {
            utm_source = conversion.utm_source || 'Direct';
            utm_medium = conversion.utm_medium || 'Direct';
            utm_campaign = conversion.utm_campaign || '(none)';
            referrer = conversion.referrer || 'Direct';

            // Get device type and session duration from page_views
            if (conversion.session_id) {
                const { data: pageViews } = await supabase
                    .from('page_views')
                    .select('device_type, duration_seconds, page_path')
                    .eq('session_id', conversion.session_id)
                    .order('created_at', { ascending: true })
                    .limit(10);

                if (pageViews && pageViews.length > 0) {
                    device_type = pageViews[0].device_type || 'Unknown';
                    session_duration_mins = Math.ceil(pageViews[pageViews.length - 1].duration_seconds / 60) || 0;
                    page_source = pageViews[0].page_path || 'Homepage';
                }
            }
        }
    } catch (err) {
        console.warn('Error fetching tracking data:', err.message);
    }

    return {
        customer_name: booking.customer_name || '',
        // The universal booking engine (routes/platform.js) writes phone/email,
        // not customer_phone/customer_email -- fall back to those real columns.
        customer_phone: booking.customer_phone || booking.phone || '',
        customer_email: booking.customer_email || booking.email || '',
        business_name: business?.name || '',
        date: dateStr,
        time_slot: timeSlot,
        boat_count: String(booking.qty || 1),
        boat_type: boatType,
        addons: addons,
        guest_count: String(booking.party_size || booking.qty || 1),
        total: (booking.total ?? booking.total_price) ? Number(booking.total ?? booking.total_price).toFixed(2) : '0.00',
        location: location,
        payment_status: booking.payment_status === 'paid' ? 'Paid' : 'Pending',
        confirmation_number: booking.id ? 'BCB-' + String(booking.id).replace(/-/g, '').substring(0, 8).toUpperCase() : '',
        payment_id: booking.payment_id || '',
        receipt_number: booking.receipt_number || '',
        receipt_url: booking.receipt_url || '',
        payment_provider: booking.payment_provider || '',
        utm_source: utm_source,
        utm_medium: utm_medium,
        utm_campaign: utm_campaign,
        referrer: referrer,
        device_type: device_type,
        session_duration_mins: String(session_duration_mins),
        page_source: page_source
    };
}

/** Normalize phone number to E.164 format (one copy, in lib/telephony). */
const normalizePhone = (phone) => telephony.normalizePhone(phone);

async function logSms(siteId, to, message, type, status, relatedId, sid, provider) {
    try {
        await supabase.from('sms_log').insert({
            site_id: siteId,
            to_phone: to,
            message: message,
            type: type,
            status: status,
            related_id: relatedId || null,
            // twilio_sid kept as the key older readers look for; provider says whose id it is.
            metadata: sid ? { twilio_sid: sid, message_id: sid, provider: provider || null } : {}
        });
    } catch (err) {
        console.error('SMS log error:', err.message);
    }
}

module.exports = { sendSms, fillTemplate, buildTemplateData, normalizePhone };
