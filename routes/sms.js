const express  = require('express');
const router   = express.Router();
const twilio   = require('twilio');
const crypto   = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const mainDb = require('../db');

const ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER    = process.env.TWILIO_PHONE_NUMBER || '+12513135464';
const GCR_URL        = process.env.GCR_UNIFIED_URL || 'https://gulfcoastradar.com';

let _adminClient = null;
function adminSb() {
  if (!_adminClient) _adminClient = createClient(
    process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY
  );
  return _adminClient;
}

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
  const sb         = adminSb();
  const fakeEmail  = `${phone.replace(/\+/, '')}@gcr.tourist`;
  const stablePass = crypto.createHash('sha256').update(phone + 'gcr-salt').digest('hex');

  // Find or create Supabase auth user
  let authUser = null;
  try {
    const { data } = await sb.auth.admin.getUserByEmail(fakeEmail);
    authUser = data?.user || null;
  } catch {}

  if (!authUser) {
    const { data: created, error: createErr } = await sb.auth.admin.createUser({
      email: fakeEmail,
      password: stablePass,
      email_confirm: true,
      user_metadata: { phone },
    });
    if (createErr) throw new Error('Could not create auth user: ' + createErr.message);
    authUser = created?.user;
  }

  // Upsert tourist_profiles keyed by user_id — phone links them
  const { data: profile, error } = await mainDb
    .from('tourist_profiles')
    .upsert({
      user_id:         authUser.id,
      phone,
      sms_opt_in:      true,
      sms_opted_in_at: new Date().toISOString(),
      last_active:     new Date().toISOString(),
      updated_at:      new Date().toISOString(),
    }, { onConflict: 'user_id' })
    .select('user_id, phone, arrival, departure, name, sms_state')
    .single();

  if (error) throw new Error('Could not save profile: ' + error.message);
  return { profile };
}

// Issue a one-time magic sign-in token for a phone (30 min). The tourist taps a
// link carrying this token and is signed straight in — no 6-digit code to type.
async function issueMagicToken(phone) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await mainDb.from('tourist_otps').upsert(
    { phone, otp_code: token, otp_expires: expires, updated_at: new Date().toISOString() },
    { onConflict: 'phone' }
  );
  return token;
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
      .select('user_id, phone, sms_opt_in, sms_state, arrival, departure')
      .eq('phone', phone)
      .maybeSingle();

    const phoneEncoded = encodeURIComponent(phone);

    // ── State: waiting for trip dates reply ───────────────────────────────────
    if (existing?.sms_state === 'awaiting_dates') {
      const dates = parseDateRange(body);

      if (dates) {
        await mainDb.from('tourist_profiles').update({
          arrival:    dates.arrival,
          departure:  dates.departure,
          sms_state:  'active',
          updated_at: new Date().toISOString(),
        }).eq('user_id', existing.user_id);

        const token = await issueMagicToken(phone);
        twiml.message(
          `Perfect! We'll text you deals, happy hours & specials while you're in town 🌊\n\nTap to sign in — you're in instantly, no code to type:\n${GCR_URL}/auth?token=${token}`
        );
      } else {
        twiml.message(
          `We couldn't read that. Try something like:\n"June 5-8" or "6/5 to 6/8"\n\nWhat dates are you visiting?`
        );
      }

      return res.type('text/xml').send(twiml.toString());
    }

    // ── Already signed up — re-send a fresh tap-to-sign-in link ───────────────
    if (existing?.sms_opt_in) {
      const token = await issueMagicToken(phone);
      twiml.message(
        `Welcome back to Gulf Coast Radar! 🌊\n\nTap to sign in — no code needed:\n${GCR_URL}/auth?token=${token}\n\nReply DATES to update your visit dates anytime.`
      );
      return res.type('text/xml').send(twiml.toString());
    }

    // ── New signup ────────────────────────────────────────────────────────────
    const { profile } = await getOrCreateTourist(phone);

    await mainDb.from('tourist_profiles').update({
      sms_state:  'awaiting_dates',
      updated_at: new Date().toISOString(),
    }).eq('user_id', profile.user_id);

    const token = await issueMagicToken(phone);
    twiml.message(
      `You're in! 🎉 Welcome to Gulf Coast Radar.\n\nSave our contact (1 tap):\n${GCR_URL}/gcr.vcf\n\nTap to sign in — you're in instantly, no code to type:\n${GCR_URL}/auth?token=${token}\n\nWhat dates are you visiting the Gulf Coast? (e.g. "June 5-8")\nWe'll send you deals & specials while you're in town!\n\nReply STOP to opt out anytime.`
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
