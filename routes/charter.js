// ============================================================
// Fishing Charter Booking System
// Charter inventory, availability, liability waiver, deposit payment
//
// SQL — run in CyberCheck DB:
//
// CREATE TABLE IF NOT EXISTS charter_listings (
//   id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id           text NOT NULL,
//   name              text NOT NULL,
//   description       text,
//   boat_name         text,
//   boat_length       int,
//   max_passengers    int DEFAULT 6,
//   base_price        numeric NOT NULL,
//   image_url         text,
//   trip_types        text[],   -- ['Inshore','Offshore','Deep Sea']
//   durations         jsonb,    -- [{label,hours,price}]
//   active            boolean DEFAULT true,
//   sort_order        int DEFAULT 0,
//   created_at        timestamptz DEFAULT now()
// );
//
// CREATE TABLE IF NOT EXISTS charter_schedule (
//   id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id       text NOT NULL,
//   day_of_week   int[],
//   specific_date date,
//   active        boolean DEFAULT true,
//   created_at    timestamptz DEFAULT now()
// );
//
// CREATE TABLE IF NOT EXISTS charter_blocks (
//   id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id    text NOT NULL,
//   block_date date NOT NULL,
//   reason     text,
//   created_at timestamptz DEFAULT now()
// );
//
// CREATE TABLE IF NOT EXISTS charter_departure_times (
//   id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id    text NOT NULL,
//   time_slot  time NOT NULL,
//   label      text,
//   active     boolean DEFAULT true,
//   created_at timestamptz DEFAULT now()
// );
//
// CREATE TABLE IF NOT EXISTS charter_bookings (
//   id                       uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id                  text NOT NULL,
//   charter_id               uuid,
//   charter_name             text,
//   trip_date                date NOT NULL,
//   departure_time           time NOT NULL,
//   duration_hours           numeric,
//   duration_label           text,
//   party_size               int DEFAULT 1,
//   total_price              numeric,
//   deposit_amount           numeric,
//   deposit_paid             boolean DEFAULT false,
//   balance_amount           numeric,
//   balance_paid             boolean DEFAULT false,
//   stripe_deposit_intent_id text,
//   customer_name            text NOT NULL,
//   customer_phone           text,
//   customer_email           text,
//   experience               text,
//   addons                   text[],
//   notes                    text,
//   waiver_signed            boolean DEFAULT false,
//   waiver_skipped           boolean DEFAULT false,
//   waiver_signature         text,
//   gallery_url              text,
//   gallery_delivered_at     timestamptz,
//   status                   text DEFAULT 'pending',
//   created_at               timestamptz DEFAULT now()
// );
// ============================================================

const express = require('express');
const { authRequired } = require('../middleware/auth');
const supabase = require('../db');
function getStripe() { return require('stripe')(process.env.STRIPE_SECRET_KEY); }
const router   = express.Router();

const { normalizePhone } = require('../utils/sms');
function getSms() { return require('../utils/sms').sendSms; }

// ── Public: get config + charter listings ─────────────────────
router.get('/config/:site_id', async (req, res) => {
  try {
    const { site_id } = req.params;
    const [bizRes, chartersRes, connRes] = await Promise.all([
      supabase.from('businesses').select('name,type,stripe_account_id').eq('site_id', site_id).single(),
      supabase.from('charter_listings').select('*').eq('site_id', site_id).eq('active', true).order('sort_order'),
      supabase.from('connections').select('account_id,stripe_publishable_key').eq('site_id', site_id).eq('provider','stripe').single(),
    ]);
    res.json({
      business_name: bizRes.data?.name,
      business_type: bizRes.data?.type,
      stripe_publishable_key: connRes.data?.stripe_publishable_key,
      charters: chartersRes.data || [],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Public: blocked dates for calendar ───────────────────────
router.get('/blocked-dates/:site_id', async (req, res) => {
  try {
    const { site_id } = req.params;
    const { data } = await supabase
      .from('charter_blocks')
      .select('block_date')
      .eq('site_id', site_id)
      .gte('block_date', new Date().toISOString().slice(0,10));
    res.json({ blocked_dates: (data || []).map(b => b.block_date) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Public: available departure times ────────────────────────
router.get('/slots/:site_id', async (req, res) => {
  try {
    const { site_id } = req.params;
    const { date, hours, party } = req.query;

    // Get departure times configured for this business
    const { data: times } = await supabase
      .from('charter_departure_times')
      .select('time_slot, label')
      .eq('site_id', site_id)
      .eq('active', true)
      .order('time_slot');

    // Find existing bookings for the date to mark unavailable
    const { data: bookings } = await supabase
      .from('charter_bookings')
      .select('departure_time, party_size')
      .eq('site_id', site_id)
      .eq('trip_date', date)
      .in('status', ['pending','confirmed']);

    const bookedTimes = new Set((bookings || []).map(b => b.departure_time.slice(0,5)));

    const slots = (times || [
      // defaults if no config set
      { time_slot: '06:00', label: '6:00 AM' },
      { time_slot: '07:00', label: '7:00 AM' },
      { time_slot: '12:00', label: '12:00 PM' },
      { time_slot: '13:00', label: '1:00 PM' },
    ]).map(t => {
      const ts = t.time_slot.slice(0,5);
      return { time: ts, label: t.label || formatTime(ts), available: !bookedTimes.has(ts) };
    });

    res.json({ slots });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function formatTime(t) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ampm}`;
}

// ── Public: create booking + charge deposit ───────────────────
router.post('/book', async (req, res) => {
  try {
    const {
      site_id, charter_id, charter_name, trip_date, departure_time,
      duration_hours, duration_label, party_size, total_price, deposit_amount,
      addons, customer_name, customer_phone, customer_email, experience, notes,
      waiver_signed, waiver_skipped, waiver_signature,
    } = req.body;

    if (!site_id || !trip_date || !departure_time || !customer_name || !customer_phone)
      return res.status(400).json({ error: 'Missing required fields' });

    // Get connected Stripe account
    const { data: conn } = await supabase
      .from('connections')
      .select('account_id')
      .eq('site_id', site_id)
      .eq('provider','stripe')
      .single();
    if (!conn?.account_id) return res.status(400).json({ error: 'Stripe not connected for this business' });

    const depositCents = Math.round(Number(deposit_amount) * 100);
    const feeCents     = Math.round(depositCents * 0.03);

    // Create Stripe payment intent via connected account
    const intent = await stripe.paymentIntents.create({
      amount: depositCents,
      currency: 'usd',
      application_fee_amount: feeCents,
      transfer_data: { destination: conn.account_id },
      metadata: { site_id, charter_name, trip_date, customer_phone },
    });

    // Save booking
    const { data: booking, error: dbErr } = await supabase
      .from('charter_bookings')
      .insert({
        site_id, charter_id, charter_name, trip_date,
        departure_time, duration_hours, duration_label, party_size,
        total_price: Number(total_price), deposit_amount: Number(deposit_amount),
        balance_amount: Number(total_price) - Number(deposit_amount),
        stripe_deposit_intent_id: intent.id,
        customer_name, customer_phone: normalizePhone(customer_phone),
        customer_email, experience, addons: addons || [], notes,
        waiver_signed: !!waiver_signed, waiver_skipped: !!waiver_skipped,
        waiver_signature: waiver_signature || null,
        status: 'pending',
      })
      .select('id')
      .single();

    if (dbErr) throw dbErr;

    // SMS confirmations (non-blocking)
    const sendSms = getSms();
    const phone = normalizePhone(customer_phone);
    const tripStr = `${trip_date} at ${formatTime(departure_time)}`;
    sendSms(phone, `✅ Charter booked! ${charter_name} · ${tripStr} · ${party_size} anglers. Deposit: $${Number(deposit_amount).toFixed(2)}. Ref: ${booking.id.slice(-6).toUpperCase()}`).catch(() => {});

    // Notify captain/business
    const { data: biz } = await supabase.from('businesses').select('notification_phone').eq('site_id', site_id).single();
    if (biz?.notification_phone) {
      sendSms(biz.notification_phone, `🎣 New charter booking: ${charter_name} · ${tripStr} · ${party_size} anglers. Customer: ${customer_name} ${phone}`).catch(() => {});
    }

    res.json({ client_secret: intent.client_secret, booking_id: booking.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: update booking (gallery, status) ────────────────────
router.patch('/bookings/:id', authRequired, async (req, res) => {
  try {
    const { gallery_url, status, notes } = req.body;
    const updates = {};
    if (status) updates.status = status;
    if (notes) updates.notes = notes;
    if (gallery_url) {
      updates.gallery_url = gallery_url;
      updates.gallery_delivered_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('charter_bookings')
      .update(updates)
      .eq('id', req.params.id)
      .select('customer_phone, customer_name, charter_name, trip_date')
      .single();

    if (error) throw error;

    if (gallery_url && data.customer_phone) {
      const sendSms = getSms();
      sendSms(data.customer_phone, `📸 Your trip photos are ready! ${data.charter_name} · ${data.trip_date}\n${gallery_url}`).catch(() => {});
    }

    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: CRUD for charter listings ──────────────────────────
router.get('/listings', authRequired, async (req, res) => {
  const { data, error } = await supabase.from('charter_listings').select('*').eq('site_id', req.query.site_id).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/listings', authRequired, async (req, res) => {
  const { data, error } = await supabase.from('charter_listings').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/listings/:id', authRequired, async (req, res) => {
  const { data, error } = await supabase.from('charter_listings').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/listings/:id', authRequired, async (req, res) => {
  const { error } = await supabase.from('charter_listings').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Auth: blocked dates CRUD ──────────────────────────────────
router.get('/blocks', authRequired, async (req, res) => {
  const { data, error } = await supabase.from('charter_blocks').select('*').eq('site_id', req.query.site_id).order('block_date');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/blocks', authRequired, async (req, res) => {
  const { data, error } = await supabase.from('charter_blocks').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/blocks/:id', authRequired, async (req, res) => {
  const { error } = await supabase.from('charter_blocks').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Auth: bookings list ───────────────────────────────────────
router.get('/bookings', authRequired, async (req, res) => {
  const q = supabase.from('charter_bookings').select('*').eq('site_id', req.query.site_id).order('trip_date', { ascending: true });
  if (req.query.status) q.eq('status', req.query.status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
