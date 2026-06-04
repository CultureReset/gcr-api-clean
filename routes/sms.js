const express = require('express');
const router  = express.Router();
const twilio  = require('twilio');
const { mainDb, admin } = require('../db');

const ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER  = process.env.TWILIO_PHONE_NUMBER || '+12513135464';
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
  const client = getClient();
  return client.messages.create({ from: FROM_NUMBER, to, body });
}

async function getOrCreateTourist(phone) {
  // Upsert tourist_profiles row
  const { data: profile, error } = await mainDb
    .from('tourist_profiles')
    .upsert({
      phone,
      sms_opt_in: true,
      sms_opted_in_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'phone' })
    .select('id, phone')
    .single();

  if (error) throw new Error('Could not create profile: ' + error.message);

  // Create/find Supabase auth user so we can generate a token
  const sb = admin();
  const fakeEmail = `${phone.replace(/\+/, '')}@gcr.tourist`;
  let authUser = null;
  try {
    const { data: existing } = await sb.auth.admin.getUserByEmail(fakeEmail);
    authUser = existing?.user || null;
  } catch {}

  if (!authUser) {
    const { data: created } = await sb.auth.admin.createUser({
      email: fakeEmail,
      password: profile.id,
      email_confirm: true,
      user_metadata: { phone, tourist_profile_id: profile.id },
    });
    authUser = created?.user || null;
  }

  let accessToken = null;
  if (authUser) {
    const { data: signIn } = await sb.auth.signInWithPassword({
      email: fakeEmail,
      password: profile.id,
    });
    accessToken = signIn?.session?.access_token || null;
  }

  return { profile, accessToken };
}

// POST /api/sms/inbound — Twilio webhook for incoming texts
// Twilio must be configured to POST to this URL when a message is received
router.post('/inbound', express.urlencoded({ extended: false }), async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  const from = req.body?.From;
  const body = (req.body?.Body || '').trim().toUpperCase();

  if (!from) {
    twiml.message('Something went wrong. Please try again.');
    return res.type('text/xml').send(twiml.toString());
  }

  const phone = normalizePhone(from);

  // STOP / UNSTOP handled automatically by Twilio — no action needed
  if (body === 'STOP' || body === 'UNSTOP' || body === 'HELP') {
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    // Check if already registered
    const { data: existing } = await mainDb
      .from('tourist_profiles')
      .select('id, phone, sms_opt_in')
      .eq('phone', phone)
      .maybeSingle();

    if (existing && existing.sms_opt_in) {
      // Already a member — send their link
      const { accessToken } = await getOrCreateTourist(phone);
      const link = accessToken
        ? `${TRIP_SWIPE_URL}/swipe/all?token=${encodeURIComponent(accessToken)}`
        : `${TRIP_SWIPE_URL}/swipe/all`;

      twiml.message(
        `Welcome back to Gulf Coast Radar! 🌊\n\nHere's your Trip Swipe link:\n${link}\n\nSwipe through the best of the Gulf Coast!`
      );
    } else {
      // New signup — create account and send link
      const { accessToken } = await getOrCreateTourist(phone);
      const link = accessToken
        ? `${TRIP_SWIPE_URL}/swipe/all?token=${encodeURIComponent(accessToken)}`
        : `${TRIP_SWIPE_URL}/swipe/all`;

      twiml.message(
        `You're in! 🎉 Welcome to Gulf Coast Radar.\n\nHere's your personal Trip Swipe link:\n${link}\n\nSwipe to discover the best restaurants, activities & nightlife on the Gulf Coast!\n\nReply STOP to opt out anytime.`
      );
    }
  } catch (e) {
    console.error('SMS inbound error:', e.message);
    twiml.message('Something went wrong. Text us again in a moment!');
  }

  res.type('text/xml').send(twiml.toString());
});

// POST /api/sms/send — send a one-off SMS (admin use)
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
