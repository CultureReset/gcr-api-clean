/**
 * routes/inbound-email.js
 *
 * Receives Brevo's inbound parse webhook (POST) whenever an email lands on
 * your parsing subdomain (e.g. pay.gulfcoastradar.com). Logs every raw
 * email, tries to extract a payment amount / payer / req_code, and if it
 * matches a pending song_requests row, marks it paid.
 *
 * Mounted in server.js as: mount('/api/webhooks', () => require('./routes/inbound-email'));
 * Full webhook URL to give Brevo: https://gcr-api-clean.vercel.app/api/webhooks/brevo-inbound/<secret>
 *
 * Env vars needed:
 *   GCR_SUPABASE_URL / GCR_SUPABASE_SERVICE_KEY (or SUPABASE_URL / SUPABASE_SERVICE_KEY)
 *   INBOUND_WEBHOOK_SECRET   <- pick any long random string, must match the URL Brevo posts to
 */

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY
);

// --- helpers ---------------------------------------------------------

function hashMessageId(messageId) {
  return crypto.createHash('sha256').update(messageId || '').digest('hex');
}

// Checks both the From header and the body text, since a forwarded/BCC'd
// email's From is whoever forwarded it, not the original cash.app/venmo.com/
// paypal.com sender — but that original sender is still visible as quoted
// text in the forwarded body.
function detectSourceType(fromAddress = '', bodyText = '') {
  const addr = (fromAddress + ' ' + bodyText).toLowerCase();
  if (addr.includes('cash.app') || addr.includes('square')) return 'cashapp';
  if (addr.includes('venmo.com') || addr.includes('venmo')) return 'venmo';
  if (addr.includes('paypal.com') || addr.includes('paypal')) return 'paypal';
  return 'unknown';
}

// Pulls a dollar amount out of the email body, e.g. "$12.50"
function extractAmount(text = '') {
  const match = text.match(/\$\s?([0-9]+(?:\.[0-9]{2})?)/);
  return match ? parseFloat(match[1]) : null;
}

// Pulls "from John Doe" / "from @johndoe" style payer names
function extractPayerName(text = '') {
  const match = text.match(/from\s+([A-Z][a-zA-Z.'\s]{1,40}?)(?:[\n.!,]| for | with |$)/i);
  return match ? match[1].trim() : null;
}

// Looks for a req_code like REQ-AB12 or REQ4F9K anywhere in the body/subject
function extractReqCode(text = '') {
  const match = text.match(/\bREQ[-]?[A-Z0-9]{4,8}\b/i);
  return match ? match[0].toUpperCase().replace(/^REQ-?/, 'REQ-') : null;
}

// If you route inboxes per-venue, e.g. pay+gulf-shores-tiki-bar@yourdomain.com,
// this pulls the entity_slug out of the local part after the "+".
function extractEntitySlugFromTo(toAddress = '') {
  const match = toAddress.match(/\+([a-z0-9-]+)@/i);
  return match ? match[1].toLowerCase() : null;
}

// --- route -------------------------------------------------------------

router.post('/brevo-inbound/:secret', async (req, res) => {
  // Basic shared-secret check since Brevo inbound doesn't HMAC-sign payloads.
  if (req.params.secret !== process.env.INBOUND_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const items = req.body?.items || [];
  if (!items.length) {
    return res.status(200).json({ received: 0 });
  }

  const results = [];

  for (const item of items) {
    try {
      const fromAddress = item.From?.Address || '';
      const fromName = item.From?.Name || '';
      const toAddress = item.To?.[0]?.Address || '';
      const subject = item.Subject || '';
      const rawText = item.RawTextBody || '';
      const messageId = item.MessageId || '';

      const emailHash = hashMessageId(messageId);
      const sourceType = detectSourceType(fromAddress, rawText + ' ' + subject);
      const entitySlug = extractEntitySlugFromTo(toAddress);

      // Dedup: Brevo (and any retry logic upstream) can redeliver.
      const { data: existing } = await supabase
        .from('email_webhook_log')
        .select('id')
        .eq('email_hash', emailHash)
        .maybeSingle();

      if (existing) {
        results.push({ messageId, status: 'duplicate' });
        continue;
      }

      // 1. Log the raw email unconditionally.
      const { data: logRow, error: logError } = await supabase
        .from('email_webhook_log')
        .insert({
          from_email: fromAddress,
          to_email: toAddress,
          subject,
          source_type: sourceType,
          parsed_data: item,
          matched_site_id: entitySlug,
          status: 'parsed',
          email_hash: emailHash,
          raw_text: rawText,
        })
        .select('id')
        .single();

      if (logError) throw logError;

      // Only Cash App / Venmo / PayPal emails go further into payment parsing.
      if (sourceType === 'unknown') {
        results.push({ messageId, status: 'logged_only' });
        continue;
      }

      const amount = extractAmount(rawText) ?? extractAmount(subject);
      const payerName = extractPayerName(rawText) ?? fromName;
      const reqCode = extractReqCode(rawText) ?? extractReqCode(subject);

      // 2. Record the parsed payment confirmation.
      const { data: paymentRow, error: paymentError } = await supabase
        .from('payment_confirmations')
        .insert({
          entity_slug: entitySlug,
          raw_subject: subject,
          raw_body: rawText,
          from_address: fromAddress,
          received_at: item.SentAtDate ? new Date(item.SentAtDate) : new Date(),
          parsed_amount: amount,
          parsed_from: payerName,
          parsed_note: reqCode,
          parsed_type: sourceType,
          status: 'unmatched',
        })
        .select('id')
        .single();

      if (paymentError) throw paymentError;

      // 3. Try to match against a pending song request via req_code.
      let matchedRequestId = null;
      if (reqCode) {
        const { data: pendingRequest } = await supabase
          .from('song_requests')
          .select('id, amount')
          .eq('req_code', reqCode)
          .eq('payment_status', 'pending')
          .maybeSingle();

        if (pendingRequest) {
          matchedRequestId = pendingRequest.id;

          await supabase
            .from('song_requests')
            .update({
              payment_status: 'paid',
              paid_amount: amount,
              payment_method: sourceType,
              payer_name: payerName,
              payment_confirmed_by: fromAddress,
              source_email_log_id: logRow.id,
              paid_at: new Date(),
            })
            .eq('id', matchedRequestId);

          await supabase
            .from('payment_confirmations')
            .update({ status: 'matched', matched_id: matchedRequestId })
            .eq('id', paymentRow.id);
        }
      }

      results.push({
        messageId,
        status: matchedRequestId ? 'matched' : 'unmatched',
        amount,
        reqCode,
        entitySlug,
      });
    } catch (err) {
      console.error('inbound-email item failed:', err);
      results.push({ status: 'error', error: err.message });
    }
  }

  // Always 2xx quickly — Brevo doesn't need to know your downstream logic succeeded.
  return res.status(200).json({ received: items.length, results });
});

module.exports = router;
