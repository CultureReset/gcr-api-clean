const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const mainDb = require('../db');
const { adminRequired } = require('../middleware/auth');
const { handleStaffCommand } = require('../lib/staff-commands');
const telephony = require('../lib/telephony');
const { sendSms } = require('../utils/sms');

// Every text goes through lib/telephony (Telnyx by default; Twilio only when
// TELEPHONY_PROVIDER=twilio). The number tourists text is the platform sender:
// PLATFORM_NUMBER, or TWILIO_PHONE_NUMBER on the legacy provider.
const platformNumber = () => telephony.defaultSender();

// An inbound webhook has no auth of its own — anyone who finds the URL can
// POST a forged `From` and, without a check, get back whatever the handler
// would have texted that number. The provider's signature is checked every
// time (lib/telephony verifyWebhook; for Twilio it needs
// TWILIO_WEBHOOK_BASE_URL to be the public origin Twilio signs against).
function verifyInboundSignature(req, res, next) {
  const check = telephony.verifyWebhook(req, { provider: 'twilio' });
  if (!check.ok) {
    console.error('[sms/inbound] signature check failed — rejecting request:', check.reason);
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

const normalizePhone = (raw) => telephony.normalizePhone(raw);

// An empty TwiML document: the reply, when there is one, is sent through
// lib/telephony rather than in the webhook response, so every provider
// answers the same way.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

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
router.post('/inbound', express.urlencoded({ extended: false }), verifyInboundSignature, async (req, res) => {
  const from = req.body?.From;
  const body = (req.body?.Body || '').trim();
  try {
    if (from) {
      const { reply } = await handlePlatformInbound({ from, body });
      if (reply) await sendSms(normalizePhone(from), reply, null, 'staff_command_reply', null, platformNumber());
    }
  } catch (e) {
    console.error('SMS inbound error:', e.message);
  }
  res.type('text/xml').send(EMPTY_TWIML);
});

/**
 * A text to the platform number, whichever provider delivered it: staff
 * quick-toggle commands, QR attribution and tourist sign-up. Returns
 * { reply } — the text to send back, or null. Also used by the Telnyx
 * messaging webhook (routes/telephony-live.js) for numbers that are neither
 * the concierge nor a Phone Agent.
 */
async function handlePlatformInbound({ from, body }) {
  const text  = String(body || '').trim();
  const upper = text.toUpperCase();
  const phone = normalizePhone(from);
  if (!phone) return { reply: null };

  // STOP / START / HELP are the carrier's (and lib/telephony's opt-out list's).
  if (['STOP','UNSTOP','START','HELP'].includes(upper)) return { reply: null };

  // Business staff quick-toggle commands (SOLD OUT <item>, ON TAP <item>,
  // etc.) share this same inbound number with tourist signup — checked
  // first since it only ever matches a phone in business_staff, which is
  // never a tourist's number.
  try {
    const staffReply = await handleStaffCommand(phone, text);
    if (staffReply) return { reply: staffReply };
  } catch (e) {
    console.error('[sms/inbound] staff command check failed:', e.message);
  }

  // QR-code attribution — a QR-driven text reads "<KEYWORD> <CODE>". The
  // tourist never sees or types the code (the QR pre-fills it); we just log
  // which physical QR code drove this text so it shows up in the admin dashboard.
  // The keyword in front is optional (SMS_QR_KEYWORD may be unset); a match
  // only counts when the code is a real sms_qr_codes keyword.
  const qrMatch = upper.match(/^(?:[A-Z]+(?:\s+[A-Z]+)?\s+)?([A-Z0-9]{4,8})\b/);
  if (qrMatch) {
    try {
      const { data: qr } = await mainDb.from('sms_qr_codes').select('id').eq('keyword', qrMatch[1]).maybeSingle();
      if (qr) await mainDb.from('sms_qr_scans').insert({ qr_code_id: qr.id, phone });
    } catch (e) { console.error('QR scan log failed:', e.message); }
  }

  // Outbound replies to tourists stay off until the platform number's texting
  // registration is approved; every inbound text is still received and turned
  // into a saved tourist_profiles row / state update.
  const { data: existing } = await mainDb
    .from('tourist_profiles')
    .select('user_id, phone, sms_opt_in, sms_state, arrival, departure')
    .eq('phone', phone)
    .maybeSingle();

  // ── State: waiting for trip dates reply ─────────────────────────────────
  if (existing?.sms_state === 'awaiting_dates') {
    const dates = parseDateRange(text);
    if (dates) {
      await mainDb.from('tourist_profiles').update({
        arrival:    dates.arrival,
        departure:  dates.departure,
        sms_state:  'active',
        updated_at: new Date().toISOString(),
      }).eq('user_id', existing.user_id);
      await issueMagicToken(phone); // stored for later use; not texted back right now
    }
    return { reply: null };
  }

  // ── Already signed up ───────────────────────────────────────────────────
  if (existing?.sms_opt_in) {
    await issueMagicToken(phone);
    return { reply: null };
  }

  // ── New signup ──────────────────────────────────────────────────────────
  const { profile } = await getOrCreateTourist(phone);
  await mainDb.from('tourist_profiles').update({
    sms_state:  'awaiting_dates',
    updated_at: new Date().toISOString(),
  }).eq('user_id', profile.user_id);
  await issueMagicToken(phone);
  return { reply: null };
}

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

    let sent = 0;
    for (const p of profiles) {
      // utils/sms honours opt-outs and logs every attempt.
      const r = await sendSms(p.phone, message, null, 'blast', null, platformNumber());
      if (r.success) sent++;
      else console.error('Failed to send to', p.phone, r.reason);
      // Spaced out to stay under the carrier's per-second limit.
      await new Promise(r2 => setTimeout(r2, 100));
    }

    res.json({ sent, total: profiles.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sms/send — send a one-off SMS (admin only — this sends real
// texts on the platform's carrier balance to any number, must never be public)
router.post('/send', adminRequired, async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  const r = await sendSms(normalizePhone(to) || to, message, null, 'admin_send', null, platformNumber());
  if (!r.success) return res.status(500).json({ error: r.reason || 'Send failed' });
  res.json({ success: true, sid: r.id });
});

// ── QR code campaigns ─────────────────────────────────────────────────────────
// Each QR code encodes an sms: link pre-filled with "<SMS_QR_KEYWORD> <CODE>" — scanning
// it just opens Messages with Send ready to tap. The code itself is invisible
// to the tourist; the inbound webhook above logs which code drove the text.
// ─────────────────────────────────────────────────────────────────────────────

const QR_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — stays readable in the dashboard
function generateKeyword() {
  let s = '';
  for (let i = 0; i < 5; i++) s += QR_CHARSET[crypto.randomInt(QR_CHARSET.length)];
  return s;
}
// The word a QR text starts with is configuration (SMS_QR_KEYWORD); the
// inbound handler accepts any word followed by the code.
function qrLinks(keyword) {
  const word = (process.env.SMS_QR_KEYWORD || '').trim();
  const body = word ? `${word} ${keyword}` : keyword;
  const number = platformNumber();
  return { sms_body: body, sms_link: number ? `sms:${number}?body=${encodeURIComponent(body)}` : null };
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
module.exports.handlePlatformInbound = handlePlatformInbound;
