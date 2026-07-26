const express  = require('express');
const router   = express.Router();
const twilio   = require('twilio');
const crypto   = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const mainDb = require('../db');
const { adminRequired } = require('../middleware/auth');
const { handleStaffCommand } = require('../lib/staff-commands');

const ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER    = process.env.TWILIO_PHONE_NUMBER || '+12513135464';
const GCR_URL        = process.env.GCR_UNIFIED_URL || 'https://gulfcoastradar.com';
// Must exactly match the "A message comes in" webhook URL configured on the
// Twilio phone number's console page — Twilio signs against that literal
// URL, not whatever the server thinks its own host is. VERIFY THIS MATCHES
// before relying on it; a mismatch makes every real inbound text fail
// silently with a 403, not just a security check that's merely too loose.
const TWILIO_INBOUND_URL = process.env.TWILIO_INBOUND_WEBHOOK_URL || 'https://gcr-api-clean.vercel.app/api/sms/inbound';

// Twilio's inbound webhook has no built-in auth — anyone who finds the URL
// can POST a forged `From` and, without this check, get back whatever the
// handler would have texted that number (including a magic sign-in token).
// This validates the request actually came from Twilio using the shared
// auth token, per Twilio's request-validation scheme.
function verifyTwilioSignature(req, res, next) {
  const signature = req.headers['x-twilio-signature'];
  const valid = AUTH_TOKEN && signature && twilio.validateRequest(AUTH_TOKEN, signature, TWILIO_INBOUND_URL, req.body || {});
  if (!valid) {
    console.error('[sms/inbound] Twilio signature validation failed — rejecting request');
    return res.status(403).send('Forbidden');
  }
  next();
}

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
// Outbound replies from this number are suppressed for now (A2P 10DLC
// campaign registration is still pending, so the carrier silently drops
// them anyway — no point spending on sends that never land). Every
// inbound text is still received, logged, and turned into a saved
// tourist_profiles row / state update exactly as before; only the
// twiml.message(...) reply calls are skipped. Re-enable by restoring
// those calls once A2P 10DLC is approved.
router.post('/inbound', express.urlencoded({ extended: false }), verifyTwilioSignature, async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const from  = req.body?.From;
  const body  = (req.body?.Body || '').trim();
  const upper = body.toUpperCase();

  if (!from) {
    return res.type('text/xml').send(twiml.toString());
  }

  const phone = normalizePhone(from);

  // STOP / UNSTOP / HELP handled by Twilio automatically
  if (['STOP','UNSTOP','HELP'].includes(upper)) {
    return res.type('text/xml').send(twiml.toString());
  }

  // Business staff quick-toggle commands (SOLD OUT <item>, ON TAP <item>,
  // etc.) share this same inbound number with tourist signup — checked
  // first since it only ever matches a phone in business_staff, which is
  // never a tourist's number. Falls through to tourist handling below for
  // every other phone (the entire current inbound volume, since this table
  // is brand new).
  try {
    const staffReply = await handleStaffCommand(phone, body);
    if (staffReply) {
      twiml.message(staffReply);
      return res.type('text/xml').send(twiml.toString());
    }
  } catch (e) {
    console.error('[sms/inbound] staff command check failed:', e.message);
  }

  // QR-code attribution — a QR-driven text reads "BEACH <CODE>" / "BEACHES <CODE>".
  // The tourist never sees or types the code (the QR pre-fills it); we just log
  // which physical QR code drove this text so it shows up in the admin dashboard.
  // Awaited (not fire-and-forget) since Vercel functions can be frozen the
  // instant the response is sent, which would silently drop an un-awaited insert.
  const qrMatch = upper.match(/^(?:BEACH|BEACHES|THE BEACH)\s+([A-Z0-9]{4,8})\b/);
  if (qrMatch) {
    try {
      const { data: qr } = await mainDb.from('sms_qr_codes').select('id').eq('keyword', qrMatch[1]).maybeSingle();
      if (qr) await mainDb.from('sms_qr_scans').insert({ qr_code_id: qr.id, phone });
    } catch (e) { console.error('QR scan log failed:', e.message); }
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

        await issueMagicToken(phone); // stored for later use; not texted back right now
      }

      return res.type('text/xml').send(twiml.toString());
    }

    // ── Already signed up ──────────────────────────────────────────────────────
    if (existing?.sms_opt_in) {
      await issueMagicToken(phone); // stored for later use; not texted back right now
      return res.type('text/xml').send(twiml.toString());
    }

    // ── New signup ────────────────────────────────────────────────────────────
    const { profile } = await getOrCreateTourist(phone);

    await mainDb.from('tourist_profiles').update({
      sms_state:  'awaiting_dates',
      updated_at: new Date().toISOString(),
    }).eq('user_id', profile.user_id);

    await issueMagicToken(phone); // stored for later use; not texted back right now

  } catch (e) {
    console.error('SMS inbound error:', e.message);
  }

  res.type('text/xml').send(twiml.toString());
});

// POST /api/sms/blast — send promos/deals to all tourists currently in town
// Body: { message, tags? } — admin only
router.post('/blast', adminRequired, async (req, res) => {
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

// POST /api/sms/send — send a one-off SMS (admin only — this sends real
// texts on your Twilio balance to any number, must never be public)
router.post('/send', adminRequired, async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  try {
    const result = await sendSMS(normalizePhone(to), message);
    res.json({ success: true, sid: result.sid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── QR code campaigns ─────────────────────────────────────────────────────────
// Each QR code encodes an sms: link pre-filled with "BEACHES <CODE>" — scanning
// it just opens Messages with Send ready to tap. The code itself is invisible
// to the tourist; the inbound webhook above logs which code drove the text.
// ─────────────────────────────────────────────────────────────────────────────

const QR_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — stays readable in the dashboard
function generateKeyword() {
  let s = '';
  for (let i = 0; i < 5; i++) s += QR_CHARSET[crypto.randomInt(QR_CHARSET.length)];
  return s;
}
function qrLinks(keyword) {
  const body = `BEACHES ${keyword}`;
  return { sms_body: body, sms_link: `sms:${FROM_NUMBER}?body=${encodeURIComponent(body)}` };
}

// POST /api/sms/qr-codes — admin: create a new trackable QR code
router.post('/qr-codes', adminRequired, async (req, res) => {
  const label = (req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: 'label required' });

  let row = null, error = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const keyword = generateKeyword();
    ({ data: row, error } = await mainDb
      .from('sms_qr_codes')
      .insert({ label, keyword })
      .select('id, label, keyword, created_at')
      .single());
    if (error && error.code !== '23505') break; // anything but a unique-violation is fatal — stop retrying
  }
  if (!row) return res.status(500).json({ error: error?.message || 'Could not generate a unique code' });

  res.json({ ...row, ...qrLinks(row.keyword) });
});

// GET /api/sms/qr-codes — admin: list all QR codes with scan counts
router.get('/qr-codes', adminRequired, async (req, res) => {
  const { data: codes, error } = await mainDb
    .from('sms_qr_codes')
    .select('id, label, keyword, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const { data: scans } = await mainDb.from('sms_qr_scans').select('qr_code_id');
  const counts = {};
  for (const s of scans || []) counts[s.qr_code_id] = (counts[s.qr_code_id] || 0) + 1;

  res.json({
    codes: (codes || []).map(c => ({ ...c, scans: counts[c.id] || 0, ...qrLinks(c.keyword) })),
  });
});

// GET /api/sms/qr-codes/:id/scans — admin: who signed up from this code (phone + name if known)
router.get('/qr-codes/:id/scans', adminRequired, async (req, res) => {
  const { data: scans, error } = await mainDb
    .from('sms_qr_scans')
    .select('phone, created_at')
    .eq('qr_code_id', req.params.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const phones = [...new Set((scans || []).map(s => s.phone).filter(Boolean))];
  const names = {};
  if (phones.length) {
    const { data: profiles } = await mainDb.from('tourist_profiles').select('phone, name').in('phone', phones);
    for (const p of profiles || []) names[p.phone] = p.name;
  }

  res.json({ scans: (scans || []).map(s => ({ ...s, name: names[s.phone] || null })) });
});

// DELETE /api/sms/qr-codes/:id — admin: remove a QR code (and its scan log)
router.delete('/qr-codes/:id', adminRequired, async (req, res) => {
  const { error } = await mainDb.from('sms_qr_codes').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
