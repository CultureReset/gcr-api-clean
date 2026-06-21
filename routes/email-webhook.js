const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { sendSms } = require('../utils/sms');
const venmoExtractor = require('../extractors/venmo');
const cashappExtractor = require('../extractors/cashapp');

const router = express.Router();

const SOURCE_MAP = [
  { re: /notifications@venmo\.com/i, source: 'venmo' },
  { re: /cash@square\.com/i, source: 'cashapp' },
  { re: /no-reply@cash\.app/i, source: 'cashapp' },
  { re: /no-reply@squareup\.com/i, source: 'cashapp' },
  { re: /notifications@airbnb\.com/i, source: 'airbnb' },
  { re: /automated@airbnb\.com/i, source: 'airbnb' },
  { re: /noreply@vrbo\.com/i, source: 'vrbo' },
  { re: /noreply@booking\.com/i, source: 'booking_com' },
  { re: /do-not-reply@toasttab\.com/i, source: 'toast' },
  { re: /reports@toasttab\.com/i, source: 'toast' },
];

function detectSource(fromEmail) {
  const match = SOURCE_MAP.find(r => r.re.test(fromEmail || ''));
  return match ? match.source : 'unknown';
}

function computeEmailHash(from, subject, text) {
  const input = (from || '') + (subject || '') + (text || '').slice(0, 500);
  return crypto.createHash('sha256').update(input).digest('hex');
}

router.post('/email', express.urlencoded({ extended: false }), async (req, res) => {
  const secret = process.env.EMAIL_WEBHOOK_SECRET;
  const headerSecret = req.headers['x-webhook-secret'];

  if (secret && headerSecret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const from = req.body.from || '';
    const to = req.body.to || '';
    const subject = req.body.subject || '';
    const text = req.body.text || '';
    const html = req.body.html || '';

    const sourceType = detectSource(from);
    const emailHash = computeEmailHash(from, subject, text);
    const siteId = req.query.site_id || (to || '').split('@')[0];

    // Check for duplicate
    const { data: existing } = await db
      .from('email_webhook_log')
      .select('id')
      .eq('email_hash', emailHash)
      .maybeSingle();

    if (existing) {
      // Log as duplicate and return 200
      await db.from('email_webhook_log').insert({
        from_email: from,
        to_email: to,
        subject,
        source_type: sourceType,
        status: 'duplicate',
        email_hash: emailHash,
        matched_site_id: siteId,
      });
      return res.status(200).json({ status: 'duplicate', message: 'Email already processed' });
    }

    let logEntry = {
      from_email: from,
      to_email: to,
      subject,
      source_type: sourceType,
      matched_site_id: siteId,
      email_hash: emailHash,
    };

    // Route to extractor based on source
    if (sourceType === 'venmo' || sourceType === 'cashapp') {
      const extractor = sourceType === 'venmo' ? venmoExtractor : cashappExtractor;
      const parsed = extractor.extract(text, html, from);

      if (!parsed) {
        logEntry.status = 'unmatched';
        logEntry.raw_text = text;
        await db.from('email_webhook_log').insert(logEntry);
        return res.status(200).json({ status: 'unmatched' });
      }

      logEntry.parsed_data = parsed;
      logEntry.confidence = parsed.confidence;

      if (parsed.confidence < 0.6) {
        logEntry.status = 'needs_review';
        await db.from('email_webhook_log').insert(logEntry);
        return res.status(200).json({ status: 'needs_review' });
      }

      // Find matching request (song, cooperative, or goal)
      if (!parsed.reqCode) {
        logEntry.status = 'unmatched';
        logEntry.raw_text = text;
        await db.from('email_webhook_log').insert(logEntry);
        return res.status(200).json({ status: 'unmatched', reason: 'no_req_code' });
      }

      // Check for song request match
      const { data: songRequest } = await db
        .from('song_requests')
        .select('*')
        .eq('req_code', parsed.reqCode)
        .eq('payment_status', 'pending')
        .maybeSingle();

      // Check for cooperative contribution match
      const { data: coopContribution } = await db
        .from('cooperative_contributions')
        .select('*, song_cooperatives!inner(id, artist_id, target_amount, current_amount)')
        .eq('req_code', parsed.reqCode)
        .eq('payment_status', 'pending')
        .maybeSingle();

      // Check for goal contribution match
      const { data: goalContribution } = await db
        .from('goal_contributions')
        .select('*, artist_goals!inner(id, artist_id, target_amount, current_amount)')
        .eq('req_code', parsed.reqCode)
        .eq('payment_status', 'pending')
        .maybeSingle();

      if (!songRequest && !coopContribution && !goalContribution) {
        logEntry.status = 'unmatched';
        logEntry.raw_text = text;
        await db.from('email_webhook_log').insert(logEntry);
        return res.status(200).json({ status: 'unmatched', reason: 'no_matching_request' });
      }

      // Insert email log first
      const { data: logData } = await db
        .from('email_webhook_log')
        .insert({
          ...logEntry,
          status: 'matched',
        })
        .select()
        .single();

      const now = new Date().toISOString();
      let artistId = null;
      let updateType = null;

      // Handle song request
      if (songRequest) {
        let paymentStatus = 'paid';
        if (parsed.amount < songRequest.amount) {
          paymentStatus = 'underpaid';
        } else if (parsed.amount > songRequest.amount) {
          paymentStatus = 'overpaid';
        }

        await db
          .from('song_requests')
          .update({
            payment_status: paymentStatus,
            paid_at: now,
            paid_amount: parsed.amount,
            payer_name: parsed.senderName,
            payment_method: sourceType,
            payment_confirmed_by: 'webhook',
            source_email_log_id: logData?.id,
          })
          .eq('id', songRequest.id);

        artistId = songRequest.artist_id;
        updateType = 'song_request';
      }

      // Handle cooperative contribution
      if (coopContribution) {
        const newAmount = coopContribution.song_cooperatives.current_amount + parsed.amount;
        const isNowFunded = newAmount >= coopContribution.song_cooperatives.target_amount;

        await db
          .from('cooperative_contributions')
          .update({
            payment_status: 'paid',
            paid_at: now,
            payment_method: sourceType,
          })
          .eq('id', coopContribution.id);

        // Update cooperative totals
        const { data: updatedCoop } = await db
          .from('song_cooperatives')
          .update({
            current_amount: newAmount,
            num_contributors: coopContribution.song_cooperatives.num_contributors + 1,
            status: isNowFunded ? 'funded' : 'pending',
          })
          .eq('id', coopContribution.song_cooperatives.id)
          .select()
          .single();

        artistId = coopContribution.song_cooperatives.artist_id;
        updateType = 'cooperative';
      }

      // Handle goal contribution
      if (goalContribution) {
        const newAmount = goalContribution.artist_goals.current_amount + parsed.amount;
        const isNowReached = newAmount >= goalContribution.artist_goals.target_amount;

        await db
          .from('goal_contributions')
          .update({
            payment_status: 'paid',
            paid_at: now,
            payment_method: sourceType,
          })
          .eq('id', goalContribution.id);

        // Update goal totals
        const { data: updatedGoal } = await db
          .from('artist_goals')
          .update({
            current_amount: newAmount,
            num_contributors: goalContribution.artist_goals.num_contributors + 1,
            status: isNowReached ? 'reached' : 'active',
          })
          .eq('id', goalContribution.artist_goals.id)
          .select()
          .single();

        artistId = goalContribution.artist_goals.artist_id;
        updateType = 'goal';
      }

      // Send SMS to artist (via notification recipients)
      if (artistId) {
        const { data: artist } = await db
          .from('artist_profiles')
          .select('site_id')
          .eq('id', artistId)
          .maybeSingle();

        if (artist?.site_id) {
          const { data: recipients } = await db
            .from('notification_recipients')
            .select('phone')
            .eq('site_id', artist.site_id)
            .eq('notify_song_request', true)
            .eq('is_active', true);

          if (recipients && recipients.length > 0) {
            let smsMsg = '';
            if (updateType === 'song_request') {
              smsMsg = `New paid request: "${songRequest.song_title}" from ${songRequest.fan_name} — $${parsed.amount} via ${sourceType}. REQ: ${parsed.reqCode}`;
            } else if (updateType === 'cooperative') {
              smsMsg = `$${parsed.amount} added to "${coopContribution.song_cooperatives.song_title}" co-op! Now $${coopContribution.song_cooperatives.current_amount + parsed.amount}/$${coopContribution.song_cooperatives.target_amount}. REQ: ${parsed.reqCode}`;
            } else if (updateType === 'goal') {
              smsMsg = `$${parsed.amount} toward your "${goalContribution.artist_goals.goal_name}" goal! Now $${goalContribution.artist_goals.current_amount + parsed.amount}/$${goalContribution.artist_goals.target_amount}. REQ: ${parsed.reqCode}`;
            }

            for (const recipient of recipients) {
              await sendSms(recipient.phone, smsMsg, artist.site_id, 'payment_received');
            }
          }
        }
      }

      return res.status(200).json({ status: 'matched', updateType, reqCode: parsed.reqCode });
    }

    // For other sources (airbnb, vrbo, toast, etc.) — log but don't process yet
    logEntry.status = 'unmatched';
    logEntry.raw_text = text;
    await db.from('email_webhook_log').insert(logEntry);
    return res.status(200).json({ status: 'unmatched', reason: 'source_not_implemented' });
  } catch (err) {
    console.error('Email webhook error:', err);
    return res.status(200).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
