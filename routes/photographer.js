// ============================================================
// Photographer Booking System
// Session types, availability schedule, time slots, deposit payment, model release
//
// SQL — run in CyberCheck DB:
//
// CREATE TABLE IF NOT EXISTS photo_sessions (
//   id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id          text NOT NULL,
//   name             text NOT NULL,
//   description      text,
//   duration_minutes int DEFAULT 60,
//   price            numeric NOT NULL,
//   deposit_percent  int DEFAULT 50,
//   max_subjects     int,
//   image_url        text,
//   active           boolean DEFAULT true,
//   sort_order       int DEFAULT 0,
//   created_at       timestamptz DEFAULT now()
// );
//
// CREATE TABLE IF NOT EXISTS photo_availability (
//   id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id      text NOT NULL,
//   day_of_week  int[],        -- 0=Sun…6=Sat, null = specific date only
//   specific_date date,
//   start_time   time NOT NULL,
//   end_time     time NOT NULL,
//   active       boolean DEFAULT true,
//   created_at   timestamptz DEFAULT now()
// );
//
// CREATE TABLE IF NOT EXISTS photo_blocks (
//   id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id    text NOT NULL,
//   block_date date NOT NULL,
//   reason     text,
//   created_at timestamptz DEFAULT now()
// );
//
// CREATE TABLE IF NOT EXISTS photo_bookings (
//   id                        uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id                   text NOT NULL,
//   session_id                uuid,
//   session_name              text,
//   session_date              date NOT NULL,
//   session_time              time NOT NULL,
//   duration_minutes          int,
//   customer_name             text NOT NULL,
//   customer_email            text,
//   customer_phone            text,
//   subjects                  int DEFAULT 1,
//   location                  text,
//   notes                     text,
//   total_price               numeric,
//   deposit_amount            numeric,
//   deposit_paid              boolean DEFAULT false,
//   balance_amount            numeric,
//   balance_paid              boolean DEFAULT false,
//   stripe_deposit_intent_id  text,
//   model_release_signed      boolean DEFAULT false,
//   model_release_signature   text,
//   gallery_url               text,
//   gallery_delivered_at      timestamptz,
//   status                    text DEFAULT 'pending',
//   created_at                timestamptz DEFAULT now()
// );
// ============================================================

const express = require('express');
const { authRequired } = require('../middleware/auth');
const supabase = require('../db');
const router   = express.Router();

const { normalizePhone } = require('../utils/sms');
function getSms() { return require('../utils/sms').sendSms; }

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

// Convert "HH:MM" time string to minutes since midnight
function toMins(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Convert minutes since midnight to "HH:MM"
function fromMins(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return String(h).padStart(2,'0') + ':' + String(min).padStart(2,'0');
}

// Format "HH:MM" → "10:00 AM"
function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr   = h % 12 || 12;
  return hr + ':' + String(m).padStart(2,'0') + ' ' + ampm;
}

// Generate available time slots for a given date
async function getAvailableSlots(siteId, dateStr, durationMins) {
  const dow = new Date(dateStr + 'T12:00:00').getDay(); // 0=Sun

  // Get working hours for this day
  const { data: schedules } = await supabase
    .from('photo_availability')
    .select('start_time, end_time, day_of_week, specific_date')
    .eq('site_id', siteId)
    .eq('active', true);

  const schedule = (schedules || []).find(s =>
    (s.specific_date === dateStr) ||
    (Array.isArray(s.day_of_week) && s.day_of_week.includes(dow) && !s.specific_date)
  );

  if (!schedule) return []; // not a working day

  // Get existing bookings for this date
  const { data: booked } = await supabase
    .from('photo_bookings')
    .select('session_time, duration_minutes')
    .eq('site_id', siteId)
    .eq('session_date', dateStr)
    .in('status', ['pending', 'confirmed']);

  const bookedRanges = (booked || []).map(b => ({
    start: toMins(b.session_time.slice(0,5)),
    end:   toMins(b.session_time.slice(0,5)) + (b.duration_minutes || 60),
  }));

  // Generate slots every durationMins within working hours
  const dayStart = toMins(schedule.start_time.slice(0,5));
  const dayEnd   = toMins(schedule.end_time.slice(0,5));
  const slots    = [];
  let cursor     = dayStart;

  while (cursor + durationMins <= dayEnd) {
    const slotEnd = cursor + durationMins;
    const conflict = bookedRanges.some(b => cursor < b.end && slotEnd > b.start);
    if (!conflict) slots.push(fromMins(cursor));
    cursor += 30; // 30-min increments
  }

  return slots;
}

async function getStripeForSite(siteId) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const { data: conn } = await supabase
    .from('connections')
    .select('account_id')
    .eq('site_id', siteId)
    .eq('provider', 'stripe')
    .eq('status', 'connected')
    .maybeSingle();
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  stripe._connectedAccountId = conn?.account_id || null;
  return stripe;
}

// ─────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS (no auth)
// ─────────────────────────────────────────────────────────────

// GET /api/photographer/config/:site_id
// Returns sessions + photographer info for the booking page
router.get('/config/:site_id', async (req, res) => {
  const { site_id } = req.params;

  const [bizRes, sessionsRes] = await Promise.all([
    supabase.from('businesses').select('name, logo_url, cover_url').eq('site_id', site_id).single(),
    supabase.from('photo_sessions').select('*').eq('site_id', site_id).eq('active', true).order('sort_order'),
  ]);

  res.json({
    business: bizRes.data || {},
    sessions: sessionsRes.data || [],
  });
});

// GET /api/photographer/slots/:site_id?date=YYYY-MM-DD&duration=60
// Returns available time slots for a date
router.get('/slots/:site_id', async (req, res) => {
  const { site_id } = req.params;
  const { date, duration = 60 } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  // Check if date is blocked
  const { data: block } = await supabase
    .from('photo_blocks')
    .select('id')
    .eq('site_id', site_id)
    .eq('block_date', date)
    .maybeSingle();

  if (block) return res.json({ slots: [], blocked: true });

  const slots = await getAvailableSlots(site_id, date, parseInt(duration));
  res.json({ slots, blocked: false });
});

// GET /api/photographer/blocked-dates/:site_id?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns dates with no availability (for Flatpickr to disable)
router.get('/blocked-dates/:site_id', async (req, res) => {
  const { site_id } = req.params;
  const { from, to } = req.query;

  const today = new Date().toISOString().slice(0,10);
  const start = from || today;
  const end   = to   || new Date(Date.now() + 90 * 864e5).toISOString().slice(0,10);

  // Explicitly blocked dates
  const { data: blocks } = await supabase
    .from('photo_blocks')
    .select('block_date')
    .eq('site_id', site_id)
    .gte('block_date', start)
    .lte('block_date', end);

  // Working day-of-week schedule
  const { data: schedules } = await supabase
    .from('photo_availability')
    .select('day_of_week')
    .eq('site_id', site_id)
    .eq('active', true)
    .not('day_of_week', 'is', null);

  const workingDays = new Set(
    (schedules || []).flatMap(s => s.day_of_week || [])
  );

  // Build list of non-working days in range
  const blockedSet = new Set((blocks || []).map(b => b.block_date));
  const cur = new Date(start + 'T12:00:00Z');
  const endD = new Date(end + 'T12:00:00Z');

  while (cur <= endD) {
    const dow  = cur.getDay();
    const ds   = cur.toISOString().slice(0,10);
    if (!workingDays.has(dow)) blockedSet.add(ds);
    cur.setDate(cur.getDate() + 1);
  }

  res.json({ blocked: [...blockedSet] });
});

// POST /api/photographer/book — create booking + charge deposit
router.post('/book', async (req, res) => {
  const {
    site_id, session_id, session_date, session_time,
    customer_name, customer_email, customer_phone,
    subjects, location, notes,
    model_release_signed, model_release_signature,
    payment_method_id, // Stripe PM
  } = req.body;

  if (!site_id || !session_date || !session_time || !customer_name) {
    return res.status(400).json({ error: 'site_id, session_date, session_time, customer_name required' });
  }

  // Load session details
  const { data: session } = await supabase
    .from('photo_sessions')
    .select('*')
    .eq('id', session_id)
    .single();

  if (!session) return res.status(400).json({ error: 'Session not found' });

  // Verify slot is still available
  const available = await getAvailableSlots(site_id, session_date, session.duration_minutes);
  if (!available.includes(session_time.slice(0,5))) {
    return res.status(409).json({ error: 'That time slot is no longer available. Please pick another.' });
  }

  const depositPct    = session.deposit_percent || 50;
  const depositAmount = parseFloat((session.price * depositPct / 100).toFixed(2));
  const balanceAmount = parseFloat((session.price - depositAmount).toFixed(2));

  let depositIntentId = null;
  let depositPaid     = false;

  // Charge deposit via Stripe if payment method provided
  if (payment_method_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

      // Get connected account
      const { data: conn } = await supabase
        .from('connections')
        .select('account_id')
        .eq('site_id', site_id)
        .eq('provider', 'stripe')
        .eq('status', 'connected')
        .maybeSingle();

      const params = {
        amount:               Math.round(depositAmount * 100),
        currency:             'usd',
        payment_method:       payment_method_id,
        confirm:              true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        description:          `${session.name} deposit — ${session_date} ${fmt12(session_time)}`,
        metadata:             { site_id, session_id, session_date, customer_name },
      };

      if (conn?.account_id) {
        params.application_fee_amount = Math.round(depositAmount * 100 * 0.03); // 3% platform fee
        params.transfer_data          = { destination: conn.account_id };
      }

      const intent      = await stripe.paymentIntents.create(params);
      depositIntentId   = intent.id;
      depositPaid       = intent.status === 'succeeded';
    } catch (e) {
      return res.status(400).json({ error: 'Payment failed: ' + e.message });
    }
  }

  // Create booking
  const phone = normalizePhone(customer_phone || '') || customer_phone || null;

  const { data: booking, error } = await supabase
    .from('photo_bookings')
    .insert({
      site_id,
      session_id:               session_id || null,
      session_name:             session.name,
      session_date,
      session_time:             session_time.slice(0,5),
      duration_minutes:         session.duration_minutes,
      customer_name,
      customer_email:           customer_email || null,
      customer_phone:           phone,
      subjects:                 parseInt(subjects) || 1,
      location:                 location || null,
      notes:                    notes || null,
      total_price:              session.price,
      deposit_amount:           depositAmount,
      deposit_paid:             depositPaid,
      balance_amount:           balanceAmount,
      stripe_deposit_intent_id: depositIntentId,
      model_release_signed:     model_release_signed || false,
      model_release_signature:  model_release_signature || null,
      status:                   depositPaid ? 'confirmed' : 'pending',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Confirmation SMS to customer
  if (phone) {
    const sendSms = getSms();
    const fmtDate = new Date(session_date + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
    await sendSms(
      phone,
      `📸 Booking confirmed!\n${session.name}\n${fmtDate} at ${fmt12(session_time)}\nDeposit paid: $${depositAmount.toFixed(2)}\nBalance due: $${balanceAmount.toFixed(2)} (before your session)\n\nQuestions? Reply here anytime.`,
      site_id, 'photo_booking_confirmation', booking.id
    ).catch(() => {});
  }

  // Notify photographer
  const { data: biz } = await supabase.from('businesses').select('owner_phone').eq('site_id', site_id).single();
  if (biz?.owner_phone) {
    const sendSms = getSms();
    const fmtDate = new Date(session_date + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
    await sendSms(
      biz.owner_phone,
      `📸 New booking!\n${customer_name} · ${session.name}\n${fmtDate} at ${fmt12(session_time)}\n${subjects || 1} subject(s)${location ? '\nLocation: ' + location : ''}\nDeposit: $${depositAmount.toFixed(2)} ${depositPaid ? '✓ paid' : '(pending)'}`,
      site_id, 'photo_booking_notify', booking.id
    ).catch(() => {});
  }

  res.json({ ok: true, booking_id: booking.id, deposit_paid: depositPaid, balance_amount: balanceAmount });
});

// ─────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS (auth required)
// ─────────────────────────────────────────────────────────────

// GET /api/photographer/bookings — list bookings
router.get('/bookings', authRequired, async (req, res) => {
  const siteId = req.query.site_id || req.siteId;
  const { status, limit = 50 } = req.query;

  let q = supabase
    .from('photo_bookings')
    .select('*')
    .eq('site_id', siteId)
    .order('session_date', { ascending: true })
    .limit(parseInt(limit));

  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PATCH /api/photographer/bookings/:id — update status, add gallery link, mark balance paid
router.patch('/bookings/:id', authRequired, async (req, res) => {
  const allowed = ['status', 'gallery_url', 'gallery_delivered_at', 'balance_paid', 'notes'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (req.body.gallery_url) updates.gallery_delivered_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('photo_bookings')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // SMS customer when gallery is delivered
  if (req.body.gallery_url && data.customer_phone) {
    const sendSms = getSms();
    await sendSms(
      data.customer_phone,
      `📸 Your photos are ready!\nView your gallery here:\n${req.body.gallery_url}\n\nThank you for booking!`,
      data.site_id, 'photo_gallery_delivery', data.id
    ).catch(() => {});
  }

  res.json(data);
});

// DELETE /api/photographer/bookings/:id — cancel
router.delete('/bookings/:id', authRequired, async (req, res) => {
  const { data, error } = await supabase
    .from('photo_bookings')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Notify customer
  if (data.customer_phone) {
    const sendSms = getSms();
    await sendSms(
      data.customer_phone,
      `Your photo session on ${data.session_date} has been cancelled. Please contact us to reschedule.`,
      data.site_id, 'photo_booking_cancel', data.id
    ).catch(() => {});
  }
  res.json({ ok: true });
});

// ── SESSION TYPES ──

router.get('/sessions', authRequired, async (req, res) => {
  const siteId = req.query.site_id || req.siteId;
  const { data, error } = await supabase.from('photo_sessions').select('*').eq('site_id', siteId).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/sessions', authRequired, async (req, res) => {
  const siteId = req.body.site_id || req.siteId;
  const { name, description, duration_minutes, price, deposit_percent, max_subjects, image_url, sort_order } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'name and price required' });

  const { data, error } = await supabase.from('photo_sessions').insert({
    site_id: siteId, name, description: description || null,
    duration_minutes: parseInt(duration_minutes) || 60,
    price: parseFloat(price), deposit_percent: parseInt(deposit_percent) || 50,
    max_subjects: parseInt(max_subjects) || null, image_url: image_url || null,
    sort_order: parseInt(sort_order) || 0,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/sessions/:id', authRequired, async (req, res) => {
  const allowed = ['name','description','duration_minutes','price','deposit_percent','max_subjects','image_url','active','sort_order'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data, error } = await supabase.from('photo_sessions').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/sessions/:id', authRequired, async (req, res) => {
  await supabase.from('photo_sessions').update({ active: false }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ── AVAILABILITY SCHEDULE ──

router.get('/schedule', authRequired, async (req, res) => {
  const siteId = req.query.site_id || req.siteId;
  const { data } = await supabase.from('photo_availability').select('*').eq('site_id', siteId).eq('active', true).order('created_at');
  res.json(data || []);
});

router.post('/schedule', authRequired, async (req, res) => {
  const siteId = req.body.site_id || req.siteId;
  const { day_of_week, specific_date, start_time, end_time } = req.body;
  if (!start_time || !end_time) return res.status(400).json({ error: 'start_time and end_time required' });
  const { data, error } = await supabase.from('photo_availability').insert({
    site_id: siteId, day_of_week: day_of_week || null, specific_date: specific_date || null, start_time, end_time,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/schedule/:id', authRequired, async (req, res) => {
  await supabase.from('photo_availability').update({ active: false }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ── BLOCKED DATES ──

router.get('/blocks', authRequired, async (req, res) => {
  const siteId = req.query.site_id || req.siteId;
  const { data } = await supabase.from('photo_blocks').select('*').eq('site_id', siteId).order('block_date');
  res.json(data || []);
});

router.post('/blocks', authRequired, async (req, res) => {
  const siteId = req.body.site_id || req.siteId;
  const { block_date, reason } = req.body;
  if (!block_date) return res.status(400).json({ error: 'block_date required' });
  const { data, error } = await supabase.from('photo_blocks').insert({ site_id: siteId, block_date, reason: reason || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/blocks/:id', authRequired, async (req, res) => {
  await supabase.from('photo_blocks').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
