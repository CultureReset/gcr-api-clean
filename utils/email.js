// ============================================
// email.js — Brevo HTTP API sender
// ============================================

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';
const FROM_DEFAULT = process.env.EMAIL_FROM || 'info@cybercheckinc.com';
const PLATFORM_ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || null;

// Strip HTML tags to plain text for SMS relay
function htmlToText(html) {
    return String(html || '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .substring(0, 300);
}

// Send SMS relay to owner when OWNER_RELAY_MODE=true
async function smsOwnerRelay(to, subject, textPreview) {
    const ownerPhone = process.env.OWNER_PHONE;
    if (!ownerPhone || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return;
    try {
        const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const toList = Array.isArray(to) ? to.join(', ') : String(to);
        const body = `📧 EMAIL RELAY\nTO: ${toList}\nSUBJ: ${subject}\n──────────\n${textPreview}\n──────────\nSend manually`;
        await twilio.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to: ownerPhone });
    } catch (err) {
        console.error('Email SMS relay failed:', err.message);
    }
}

/**
 * Send an email via Brevo HTTP API
 * @param {object} opts - { to, subject, html, replyTo, from, attachments }
 */
async function sendEmail({ to, subject, html, replyTo, attachments, from }) {
    if (!to) return { success: false, reason: 'no_recipient' };

    const fromAddress = from || FROM_DEFAULT;
    const toList = Array.isArray(to) ? to : [to];
    const apiKey = process.env.BREVO_API_KEY;

    if (!apiKey) {
        console.warn('BREVO_API_KEY not set — email not sent to:', to);
        return { success: false, reason: 'not_configured' };
    }

    try {
        const body = {
            sender: { email: fromAddress.match(/<(.+)>/)?.[1] || fromAddress, name: fromAddress.match(/^(.+?)\s*</)?.[1]?.trim() || 'CyberCheck' },
            to: toList.map(e => ({ email: e })),
            subject,
            htmlContent: html,
            replyTo: replyTo ? { email: replyTo } : undefined,
            ...(PLATFORM_ADMIN_EMAIL ? { bcc: [{ email: PLATFORM_ADMIN_EMAIL }] } : {})
        };

        if (attachments && attachments.length) {
            body.attachment = attachments.map(a => ({
                name: a.filename,
                content: a.content
            }));
        }

        const res = await fetch(BREVO_API, {
            method: 'POST',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const json = await res.json();
        if (!res.ok) {
            console.error('Brevo error:', json);
            return { success: false, reason: json.message || 'brevo_error' };
        }
        console.log('Email sent via Brevo:', json.messageId, '→', toList);
        if (process.env.OWNER_RELAY_MODE === 'true') {
            smsOwnerRelay(to, subject, htmlToText(html)).catch(() => {});
        }
        return { success: true, id: json.messageId };
    } catch (err) {
        console.error('Email send error:', err.message);
        return { success: false, reason: err.message };
    }
}

/**
 * Build customer confirmation email HTML
 */
function customerConfirmationHtml(d) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:#0ea5e9;padding:32px 32px 24px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:24px;">Booking Confirmed!</h1>
          <p style="margin:8px 0 0;color:#e0f2fe;font-size:15px;">Thanks for booking with ${esc(d.business_name)}</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px;">
          <p style="margin:0 0 20px;color:#374151;font-size:15px;">Hi <strong>${esc(d.customer_name)}</strong>,</p>
          <p style="margin:0 0 24px;color:#374151;font-size:15px;">Your booking is confirmed. Here are the details:</p>

          <!-- Confirmation number -->
          ${d.confirmation_number ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;text-align:center;margin-bottom:20px;">
            <p style="margin:0 0 4px;color:#166534;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Confirmation Number</p>
            <p style="margin:0;color:#166534;font-size:26px;font-weight:800;letter-spacing:3px;">${esc(d.confirmation_number)}</p>
          </div>` : ''}

          <!-- Details box -->
          <table width="100%" style="background:#f9fafb;border-radius:10px;padding:20px;border:1px solid #e5e7eb;" cellpadding="0" cellspacing="0">
            ${row('📅 Date', d.date)}
            ${row('⏰ Time', d.time_slot)}
            ${d.boat_type ? row('🚤 Rental', d.boat_type) : ''}
            ${d.boat_count && d.boat_count !== '1' ? row('🔢 Quantity', d.boat_count) : ''}
            ${d.guest_count ? row('👥 Guests', d.guest_count) : ''}
            ${d.addons && d.addons !== 'None' ? row('➕ Add-ons', d.addons) : ''}
            ${d.location ? row('📍 Location', d.location) : ''}
            ${row('💳 Amount', '$' + d.total)}
            ${row('💰 Payment', d.payment_status)}
          </table>

          ${d.notes ? `<p style="margin:20px 0 0;color:#6b7280;font-size:13px;"><strong>Notes:</strong> ${esc(d.notes)}</p>` : ''}

          <!-- Payment Reference -->
          ${(d.receipt_number || d.payment_id) ? `<div style="margin-top:20px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:16px;">
            <p style="margin:0 0 8px;color:#0369a1;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Payment Reference</p>
            ${d.receipt_number ? `<p style="margin:0 0 4px;color:#0c4a6e;font-size:13px;"><strong>Receipt #:</strong> ${esc(d.receipt_number)}</p>` : ''}
            ${d.payment_id ? `<p style="margin:0 0 4px;color:#0c4a6e;font-size:13px;"><strong>Transaction ID:</strong> ${esc(d.payment_id)}</p>` : ''}
            ${d.receipt_url ? `<p style="margin:4px 0 0;font-size:13px;"><a href="${esc(d.receipt_url)}" style="color:#0ea5e9;">View Receipt →</a></p>` : ''}
          </div>` : ''}

          <!-- Waiver: needs signing -->
          ${d.waiver_url ? `<div style="margin-top:20px;background:#fef8e7;border:2px solid #f59e0b;border-radius:10px;padding:20px;text-align:center;">
            <p style="margin:0 0 4px;color:#92400e;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">⚠️ Action Required</p>
            <p style="margin:0 0 16px;color:#b45309;font-size:14px;font-weight:600;">Please sign your waiver before your booking</p>
            <a href="${esc(d.waiver_url)}" style="display:inline-block;background:#f59e0b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;">✍️ Sign Waiver Now →</a>
          </div>` : ''}

          <!-- Waiver: already signed -->
          ${d.waiver_acknowledgment && !d.waiver_url ? `<div style="margin-top:20px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;">
            <p style="margin:0 0 8px;color:#166534;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">✅ Waiver Signed</p>
            <p style="margin:0 0 8px;color:#166534;font-size:13px;">You have acknowledged and agreed to the waiver terms for this booking.</p>
            ${d.waiver_pdf ? `<p style="margin:8px 0 0;font-size:13px;"><a href="${esc(d.waiver_pdf)}" style="color:#16a34a;font-weight:600;text-decoration:none;">📄 Download Waiver PDF →</a></p>` : ''}
          </div>` : ''}

          <p style="margin:28px 0 0;color:#374151;font-size:15px;">Questions? Reply to this email or contact ${esc(d.business_name)} directly.</p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 32px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">This confirmation was sent automatically. Please save it for your records.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Build a lightweight confirmation email for a GCR-direct reservation
 * request (Reserve.jsx) — status is "pending", not paid/confirmed, so this
 * intentionally reads differently from customerConfirmationHtml above.
 */
function gcrReservationConfirmationHtml(d) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <tr><td style="background:#667eea;padding:32px 32px 24px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;">Reservation Requested</h1>
          <p style="margin:8px 0 0;color:#e0e7ff;font-size:15px;">${esc(d.business_name)} will confirm your requested time</p>
        </td></tr>

        <tr><td style="padding:32px;">
          <p style="margin:0 0 20px;color:#374151;font-size:15px;">Hi <strong>${esc(d.customer_name)}</strong>, here's what you requested:</p>

          <table width="100%" style="background:#f9fafb;border-radius:10px;padding:20px;border:1px solid #e5e7eb;margin-bottom:20px;" cellpadding="0" cellspacing="0">
            ${row('📅 Date', d.date)}
            ${row('⏰ Time', d.time_slot)}
            ${row('👥 Party Size', d.guest_count)}
          </table>

          ${d.notes ? `<p style="margin:0 0 20px;color:#6b7280;font-size:13px;"><strong>Notes:</strong> ${esc(d.notes)}</p>` : ''}

          <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:16px;margin-bottom:20px;">
            <p style="margin:0;color:#92400e;font-size:13px;">This is a request, not a confirmed reservation — no payment was collected. ${esc(d.business_name)} may adjust the exact time based on availability.</p>
          </div>

          <p style="margin:0;color:#374151;font-size:15px;">Questions? Contact ${esc(d.business_name)} directly.</p>
        </td></tr>

        <tr><td style="background:#f9fafb;padding:20px 32px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent automatically by Gulf Coast Radar.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Build owner new-booking notification email HTML
 */
function ownerNotificationHtml(d) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:#16a34a;padding:28px 32px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;">New Booking!</h1>
          <p style="margin:8px 0 0;color:#dcfce7;font-size:14px;">${esc(d.date)} · ${esc(d.time_slot)}</p>
          ${d.confirmation_number ? `<p style="margin:6px 0 0;color:#bbf7d0;font-size:13px;font-weight:600;">${esc(d.confirmation_number)}</p>` : ''}
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px;">

          <!-- Customer -->
          <h3 style="margin:0 0 12px;color:#111827;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Customer</h3>
          <table width="100%" style="background:#f9fafb;border-radius:10px;padding:20px;border:1px solid #e5e7eb;margin-bottom:20px;" cellpadding="0" cellspacing="0">
            ${row('👤 Name', d.customer_name)}
            ${d.customer_phone ? row('📞 Phone', d.customer_phone) : ''}
            ${d.customer_email ? row('📧 Email', d.customer_email) : ''}
          </table>

          <!-- Booking Details -->
          <h3 style="margin:0 0 12px;color:#111827;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Booking Details</h3>
          <table width="100%" style="background:#f9fafb;border-radius:10px;padding:20px;border:1px solid #e5e7eb;margin-bottom:20px;" cellpadding="0" cellspacing="0">
            ${d.confirmation_number ? row('🔖 Confirmation #', d.confirmation_number) : ''}
            ${row('📅 Date', d.date)}
            ${row('⏰ Time Slot', d.time_slot)}
            ${d.boat_type ? row('🚤 Boat Type', d.boat_type) : ''}
            ${d.boat_count ? row('🔢 Qty', d.boat_count + ' boat' + (Number(d.boat_count) !== 1 ? 's' : '')) : ''}
            ${d.guest_count ? row('👥 Guests', d.guest_count) : ''}
            ${d.addons && d.addons !== 'None' ? row('➕ Add-ons', d.addons) : ''}
            ${d.location ? row('📍 Location', d.location) : ''}
          </table>

          <!-- Payment Breakdown -->
          <h3 style="margin:0 0 12px;color:#111827;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Payment</h3>
          <table width="100%" style="background:#f9fafb;border-radius:10px;padding:20px;border:1px solid #e5e7eb;margin-bottom:20px;" cellpadding="0" cellspacing="0">
            ${d.subtotal ? row('Subtotal', '$' + Number(d.subtotal).toFixed(2)) : ''}
            ${d.platform_fee ? row('Platform Fee', '$' + Number(d.platform_fee).toFixed(2)) : ''}
            ${d.tax ? row('Tax', '$' + Number(d.tax).toFixed(2)) : ''}
            ${row('💳 Total', '$' + d.total)}
            ${row('💰 Status', d.payment_status)}
            ${d.deposit ? row('Deposit Paid', '$' + Number(d.deposit).toFixed(2)) : ''}
            ${d.balance_due ? row('Balance Due', '$' + Number(d.balance_due).toFixed(2)) : ''}
          </table>

          ${d.notes ? `<div style="margin-bottom:20px;padding:16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#92400e;text-transform:uppercase;letter-spacing:.5px;">Customer Notes</p>
            <p style="margin:0;color:#374151;font-size:14px;">${esc(d.notes)}</p>
          </div>` : ''}

          ${d.waiver_url ? `<div style="margin-bottom:20px;padding:16px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;">
            <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#0369a1;text-transform:uppercase;letter-spacing:.5px;">Waiver Link</p>
            <a href="${esc(d.waiver_url)}" style="color:#0ea5e9;font-size:13px;word-break:break-all;">${esc(d.waiver_url)}</a>
          </div>` : ''}

          <!-- Payment Reference -->
          ${(d.receipt_number || d.payment_id) ? `<div style="margin-bottom:20px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:16px;">
            <p style="margin:0 0 8px;color:#0369a1;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Payment Reference</p>
            ${d.receipt_number ? `<p style="margin:0 0 4px;color:#0c4a6e;font-size:13px;"><strong>Square Receipt #:</strong> ${esc(d.receipt_number)}</p>` : ''}
            ${d.payment_id ? `<p style="margin:0 0 4px;color:#0c4a6e;font-size:13px;"><strong>Transaction ID:</strong> ${esc(d.payment_id)}</p>` : ''}
            ${d.receipt_url ? `<p style="margin:4px 0 0;font-size:13px;"><a href="${esc(d.receipt_url)}" style="color:#0ea5e9;">View Square Receipt →</a></p>` : ''}
          </div>` : ''}

          <!-- Source Analytics -->
          <h3 style="margin:0 0 12px;color:#111827;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Booking Source</h3>
          <table width="100%" style="background:#fef3c7;border-radius:10px;padding:20px;border:1px solid #fcd34d;" cellpadding="0" cellspacing="0">
            ${row('🔍 Source', d.utm_source)}
            ${row('📢 Medium', d.utm_medium)}
            ${d.utm_campaign && d.utm_campaign !== '(none)' ? row('📊 Campaign', d.utm_campaign) : ''}
            ${row('🌐 Referrer', d.referrer)}
            ${row('📱 Device', d.device_type)}
            ${row('⏱️ Time on Site', d.session_duration_mins + ' min')}
            ${row('🔗 Landing Page', d.page_source)}
          </table>

        </td></tr>

        <tr><td style="background:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">Sent automatically by your booking system.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Build confirmation email for someone who submitted the "share your info"
 * form on an NFC/QR digital business card
 */
function nfcCardLeadConfirmationHtml(d) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <tr><td style="background:#00ada8;padding:32px 32px 24px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:22px;">Thanks for reaching out!</h1>
          <p style="margin:8px 0 0;color:#e0f7f6;font-size:15px;">${esc(d.owner_name || 'Matt')} got your info and will be in touch soon</p>
        </td></tr>

        <tr><td style="padding:32px;">
          <p style="margin:0 0 20px;color:#374151;font-size:15px;">Hi <strong>${esc(d.name)}</strong>,</p>
          <p style="margin:0 0 24px;color:#374151;font-size:15px;">Thanks for dropping your details — here's what we received:</p>

          <table width="100%" style="background:#f9fafb;border-radius:10px;padding:20px;border:1px solid #e5e7eb;" cellpadding="0" cellspacing="0">
            ${row('📞 Phone', d.phone)}
            ${row('🏢 Company', d.business_name)}
            ${row('📝 Note', d.business_type)}
          </table>

          <p style="margin:24px 0 0;color:#374151;font-size:15px;">Talk soon,<br>${esc(d.owner_name || 'Matt Johnson')}</p>
        </td></tr>

        <tr><td style="background:#f9fafb;padding:20px 32px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">This confirmation was sent automatically by CyberCheck Inc.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function row(label, value) {
    if (!value) return '';
    return `<tr>
      <td style="padding:6px 0;color:#6b7280;font-size:13px;width:120px;vertical-align:top;">${label}</td>
      <td style="padding:6px 0;color:#111827;font-size:13px;font-weight:600;">${esc(String(value))}</td>
    </tr>`;
}

function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Generate .ics calendar invite content
 */
function generateIcsContent(d) {
    const dateStr = (d.date || '').replace(/-/g, '');
    const slot = (d.time_slot || '').toLowerCase();
    let startHour = 9, endHour = 13;
    if (slot.includes('pm') && !slot.includes('am')) { startHour = 13; endHour = 17; }
    else if (slot.includes('all day') || slot.includes('full')) { startHour = 9; endHour = 17; }
    const timeMatch = (d.time_slot || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (timeMatch) {
        let h = parseInt(timeMatch[1]);
        if (timeMatch[3].toUpperCase() === 'PM' && h !== 12) h += 12;
        if (timeMatch[3].toUpperCase() === 'AM' && h === 12) h = 0;
        startHour = h;
        endHour = h + 4;
    }
    const pad = n => String(n).padStart(2, '0');
    const dtStart = dateStr + 'T' + pad(startHour) + '0000';
    const dtEnd   = dateStr + 'T' + pad(endHour)   + '0000';
    const uid = 'booking-' + Date.now() + '@circleboat';
    const summary = (d.boat_type || 'Boat Rental') + ' — ' + (d.business_name || 'Circle Boats');
    const location = d.location || 'Orange Beach, AL';
    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//CyberCheck//Booking//EN',
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        'UID:' + uid,
        'DTSTART;TZID=America/Chicago:' + dtStart,
        'DTEND;TZID=America/Chicago:' + dtEnd,
        'SUMMARY:' + summary,
        'LOCATION:' + location,
        'DESCRIPTION:Your booking is confirmed. Arrive 15 min early for check-in.',
        'STATUS:CONFIRMED',
        'END:VEVENT',
        'END:VCALENDAR'
    ].join('\r\n');
}

module.exports = { sendEmail, customerConfirmationHtml, gcrReservationConfirmationHtml, ownerNotificationHtml, nfcCardLeadConfirmationHtml, generateIcsContent };
