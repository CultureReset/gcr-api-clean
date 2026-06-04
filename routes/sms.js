const express = require('express');
const router  = express.Router();
const twilio  = require('twilio');
const { mainDb, admin } = require('../db');

const ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER    = process.env.TWILIO_PHONE_NUMBER || '+12513135464';
const TRIP_SWIPE_URL = process.env.TRIP_SWIPE_URL || 'https://gcr-trip-swipe.vercel.app';

function getClient() {
  return twilio(ACCOUNT_SID, AUTH_TOKEN);
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '+' + digits;
}

async function sendSMS(to, body) {
  return getClient().messages.create({ from: FROM_NUMBER, to, body });
}

// Parse "June 5-8", "6/5-6/8", "June 5 to June 8" style date replies
function parseDateRange(text) {
  const t = text.trim();
  const today = new Date();
  const year  = today.getFullYear();

  // Try MM/DD-MM/DD or MM/DD to MM/DD
  const mdmd = t.match(/(\d{1,2})\/(\d{1,2})\s*[-–to]+\s*(\d{1,2})\/(\d{1,2})/i);
  if (mdmd) {
    return {
      arrival:   new Date(year, +mdmd[1]-1, +mdmd[2]).toISOString().slice(0,10),
      departure: new Date(year, +mdmd[3]-1, +mdmd[4]).toISOString().slice(0,10),
    };
  }

  // Try "June 5-8" or "June 5 to 8"
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const named = t.match(/([a-z]+)\s+(\d{1,2})\s*[-–to]+\s*([a-z]*\s*)(\d{1,2})/i);
  if (named) {
    const m1 = months.findIndex(m => named[1].toLowerCase().startsWith(m));
    const m2 = named[3] ? months.findIndex(m => named[3].toLowerCase().trim().startsWith(m)) : m1;
    if (m1 >= 0) {
      return {
        arrival:   new Date(year, m1, +named[2]).toISOString().slice(0,10),
        departure: new Date(year, m2 >= 0 ? m2 : m1, +named[4]).toISOString().slice(0,10),
      };
    }
  }

  return null;
}

async function getOrCreateTourist(phone) {
  const { data: profile, error } = await mainDb
    .from('tourist_profiles')
    .upsert({
      phone,
      sms_opt_in:      true,
      sms_opted_in_at: new Date().toISOString(),
      last_active:     new Date().toISOString(),
      updated_at:      new Date().toISOString(),
    }, { onConflict: 'phone' })
    .select('id, phone, arrival, departure, name')
    .single();

  if (error) throw new Error('Could not create profile: ' + error.message);

  // Create/find Supabase auth user for token generation
  const sb = admin();
  const fakeEmail = `${phone.replace(/\+/, '')}@gcr.tourist`;
  let authUser = null;
  try {
    const { data: existing } = await sb.auth.admin.getUserByEmail(fakeEmail);
    authUser = existing?.user || null;
  } catch {}

  if (!authUser) {
    const { data: created } = await sb.auth.admin.createUser({
      email: fakeEmail, password: profile.id, email_confirm: true,
      user_metadata: { phone, tourist_profile_id: profile.id },
    });
    authUser = created?.user || null;
  }

  let accessToken = null;
  if (authUser) {
    const { data: signIn } = await sb.auth.signInWithPassword({ email: fakeEmail, password: profile.id });
    accessToken = signIn?.session?.access_token || null;
  }

  return { profile, accessToken };
}

// ── Inbound SMS state machine ─────────────────────────────────────────────────
// States stored in tourist_profiles.sms_state:
//   null / 'active'  → normal
//   'awaiting_dates' → just signed up, waiting for trip dates reply
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/sms/inbound — Twilio webhook
router.post('/inbound', express.urlencoded({ extended: false }), async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const from  = req.body?.From;
  const body  = (req.body?.Body || '').trim();
  const upper = body.toUpperCase();

  if (!from) {
    twiml.message('Something went wrong. Please try again.');
    return res.type('text/xml').send(twiml.toString());
  }

  const phone = normalizePhone(from);

  // STOP / UNSTOP / HELP handled by Twilio automatically
  if (['STOP','UNSTOP','HELP'].includes(upper)) {
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    const { data: existing } = await mainDb
      .from('tourist_profiles')
      .select('id, phone, sms_opt_in, sms_state, arrival, departure')
      .eq('phone', phone)
      .maybeSingle();

    // ── State: waiting for trip dates reply ───────────────────────────────────
    if (existing?.sms_state === 'awaiting_dates') {
      const dates = parseDateRange(body);

      if (dates) {
        // Save dates, clear state
        await mainDb.from('tourist_profiles').update({
          arrival:   dates.arrival,
          departure: dates.departure,
          sms_state: 'active',
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);

        const { accessToken } = await getOrCreateTourist(phone);
        const link = accessToken
          ? `${TRIP_SWIPE_URL}/swipe/all?token=${encodeURIComponent(accessToken)}`
          : `${TRIP_SWIPE_URL}/swipe/all`;

        twiml.message(
          `Perfect! We'll send you the best deals, happy hours & specials during your stay 🌊\n\nHere's your Trip Swipe link:\n${link}\n\nSwipe to discover the Gulf Coast!`
        );
      } else {
        // Couldn't parse — ask again
        twiml.message(
          `We couldn't read that date. Try something like:\n"June 5-8" or "6/5 to 6/8"\n\nWhat dates are you visiting?`
        );
      }

      return res.type('text/xml').send(twiml.toString());
    }

    // ── Already signed up — re-send their link ────────────────────────────────
    if (existing?.sms_opt_in) {
      const { accessToken } = await getOrCreateTourist(phone);
      const link = accessToken
        ? `${TRIP_SWIPE_URL}/swipe/all?token=${encodeURIComponent(accessToken)}`
        : `${TRIP_SWIPE_URL}/swipe/all`;

      twiml.message(
        `Welcome back to Gulf Coast Radar! 🌊\n\nHere's your Trip Swipe link:\n${link}\n\nReply DATES to update your visit dates anytime.`
      );

      return res.type('text/xml').send(twiml.toString());
    }

    // ── New signup ────────────────────────────────────────────────────────────
    const { profile, accessToken } = await getOrCreateTourist(phone);

    // Set state to awaiting_dates
    await mainDb.from('tourist_profiles').update({
      sms_state:  'awaiting_dates',
      updated_at: new Date().toISOString(),
    }).eq('id', profile.id);

    const link = accessToken
      ? `${TRIP_SWIPE_URL}/swipe/all?token=${encodeURIComponent(accessToken)}`
      : `${TRIP_SWIPE_URL}/swipe/all`;

    twiml.message(
      `You're in! 🎉 Welcome to Gulf Coast Radar.\n\nHere's your Trip Swipe link:\n${link}\n\nWhat dates are you visiting the Gulf Coast? (e.g. "June 5-8")\n\nWe'll text you deals, happy hours & specials the days you're in town!\n\nReply STOP to opt out anytime.`
    );

  } catch (e) {
    console.error('SMS inbound error:', e.message);
    twiml.message('Something went wrong. Text us again in a moment!');
  }

  res.type('text/xml').send(twiml.toString());
});

// POST /api/sms/blast — send promos/deals to all tourists currently in town
// Body: { message, tags? } — admin only
router.post('/blast', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { message, tags } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  const today = new Date().toISOString().slice(0, 10);

  try {
    // Find all opted-in tourists who are in town today
    let query = mainDb
      .from('tourist_profiles')
      .select('id, phone, name')
      .eq('sms_opt_in', true)
      .not('phone', 'is', null)
      .lte('arrival', today)
      .gte('departure', today);

    const { data: profiles, error } = await query;
    if (error) throw error;
    if (!profiles?.length) return res.json({ sent: 0, message: 'No tourists in town today' });

    const client = getClient();
    let sent = 0;
    for (const p of profiles) {
      try {
        await client.messages.create({ from: FROM_NUMBER, to: p.phone, body: message });
        sent++;
        // Small delay to avoid Twilio rate limits
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        console.error('Failed to send to', p.phone, e.message);
      }
    }

    res.json({ sent, total: profiles.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sms/send — send a one-off SMS
router.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  try {
    const result = await sendSMS(normalizePhone(to), message);
    res.json({ success: true, sid: result.sid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
