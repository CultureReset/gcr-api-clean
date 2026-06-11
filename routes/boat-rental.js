// ============================================================
// Boat Rental Booking System
// Boat inventory, hourly/half-day/full-day/multi-day rentals, deposit payment
//
// SQL — run in CyberCheck DB:
//
// CREATE TABLE IF NOT EXISTS boat_listings (
//   id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id       text NOT NULL,
//   name          text NOT NULL,
//   description   text,
//   year          int,
//   make          text,
//   model         text,
//   length_ft     int,
//   max_passengers int DEFAULT 8,
//   hourly_rate   numeric,
//   halfday_rate  numeric,
//   fullday_rate  numeric,
//   daily_rate    numeric,
//   deposit_percent int DEFAULT 50,
//   image_url     text,
//   features      text[],   -- ['GPS','Live well','Bluetooth','Bimini top']
//   active        boolean DEFAULT true,
//   sort_order    int DEFAULT 0,
//   created_at    timestamptz DEFAULT now()
// );
//
// CREATE TABLE IF NOT EXISTS boat_blocks (
//   id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id    text NOT NULL,
//   block_date date NOT NULL,
//   boat_id    uuid,
//   reason     text,
//   created_at timestamptz DEFAULT now()
// );
//
// CREATE TABLE IF NOT EXISTS boat_rentals (
//   id                       uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id                  text NOT NULL,
//   boat_id                  uuid,
//   boat_name                text,
//   rental_type              text NOT NULL,   -- hourly|halfday|fullday|multiday
//   rental_date              date NOT NULL,
//   rental_date_end          date,
//   start_time               time,
//   end_time                 time,
//   package                  text,            -- morning|afternoon
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
//   license_number           text,
//   addons                   text[],
//   notes                    text,
//   waiver_signed            boolean DEFAULT false,
//   waiver_signature         text,
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

// ── Public: get config + boat listings ───────────────────────
router.get('/config/:site_id', async (req, res) => {
  try {
    const { site_id } = req.params;
    const [bizRes, boatsRes, connRes] = await Promise.all([
      supabase.from('businesses').select('name,type').eq('site_id', site_id).single(),
      supabase.from('boat_listings').select('*').eq('site_id', site_id).eq('active', true).order('sort_order'),
      supabase.from('connections').select('account_id,stripe_publishable_key').eq('site_id', site_id).eq('provider','stripe').single(),
    ]);
    res.json({
      business_name: bizRes.data?.name,
      page_title: 'Rent a Boat',
      stripe_publishable_key: connRes.data?.stripe_publishable_key,
      boats: boatsRes.data || [],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Public: blocked dates ─────────────────────────────────────
router.get('/blocked-dates/:site_id', async (req, res) => {
  try {
    const { site_id } = req.params;
    const { data } = await supabase
      .from('boat_blocks')
      .select('block_date')
      .eq('site_id', site_id)
      .gte('block_date', new Date().toISOString().slice(0,10));
    res.json({ blocked_dates: (data || []).map(b => b.block_date) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Public: create booking + charge deposit ───────────────────
router.post('/book', async (req, res) => {
  try {
    const {
      site_id, boat_id, boat_name, rental_type, rental_date, rental_date_end,
      start_time, end_time, package: pkg, party_size, total_price, deposit_amount,
      addons, customer_name, customer_phone, customer_email, experience, license_number,
      notes, waiver_signed, waiver_signature,
    } = req.body;

    if (!site_id || !rental_date || !customer_name || !customer_phone)
      return res.status(400).json({ error: 'Missing required fields' });

    const { data: conn } = await supabase
      .from('connections')
      .select('account_id')
      .eq('site_id', site_id)
      .eq('provider','stripe')
      .single();
    if (!conn?.account_id) return res.status(400).json({ error: 'Stripe not connected' });

    const depositCents = Math.round(Number(deposit_amount) * 100);
    const feeCents     = Math.round(depositCents * 0.03);

    const intent = await stripe.paymentIntents.create({
      amount: depositCents,
      currency: 'usd',
      application_fee_amount: feeCents,
      transfer_data: { destination: conn.account_id },
      metadata: { site_id, boat_name, rental_date, customer_phone },
    });

    const { data: booking, error: dbErr } = await supabase
      .from('boat_rentals')
      .insert({
        site_id, boat_id, boat_name, rental_type, rental_date,
        rental_date_end: rental_date_end || null,
        start_time: start_time || null, end_time: end_time || null,
        package: pkg || null, party_size: Number(party_size),
        total_price: Number(total_price), deposit_amount: Number(deposit_amount),
        balance_amount: Number(total_price) - Number(deposit_amount),
        stripe_deposit_intent_id: intent.id,
        customer_name, customer_phone: normalizePhone(customer_phone),
        customer_email, experience, license_number: license_number || null,
        addons: addons || [], notes,
        waiver_signed: !!waiver_signed, waiver_signature: waiver_signature || null,
        status: 'pending',
      })
      .select('id')
      .single();

    if (dbErr) throw dbErr;

    const sendSms = getSms();
    const phone = normalizePhone(customer_phone);
    const typeLabel = { hourly: 'Hourly', halfday: 'Half-Day', fullday: 'Full-Day', multiday: 'Multi-Day' }[rental_type] || rental_type;
    sendSms(phone, `✅ Boat reserved! ${boat_name} · ${typeLabel} · ${rental_date}. Deposit: $${Number(deposit_amount).toFixed(2)}. Ref: ${booking.id.slice(-6).toUpperCase()}`).catch(() => {});

    const { data: biz } = await supabase.from('businesses').select('notification_phone').eq('site_id', site_id).single();
    if (biz?.notification_phone) {
      sendSms(biz.notification_phone, `⛵ New boat rental: ${boat_name} · ${typeLabel} · ${rental_date} · ${party_size} passengers. Customer: ${customer_name} ${phone}`).catch(() => {});
    }

    res.json({ client_secret: intent.client_secret, booking_id: booking.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: CRUD for boat listings ──────────────────────────────
router.get('/listings', authRequired, async (req, res) => {
  const { data, error } = await supabase.from('boat_listings').select('*').eq('site_id', req.query.site_id).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/listings', authRequired, async (req, res) => {
  const { data, error } = await supabase.from('boat_listings').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/listings/:id', authRequired, async (req, res) => {
  const { data, error } = await supabase.from('boat_listings').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/listings/:id', authRequired, async (req, res) => {
  const { error } = await supabase.from('boat_listings').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Auth: blocked dates CRUD ──────────────────────────────────
router.post('/blocks', authRequired, async (req, res) => {
  const { data, error } = await supabase.from('boat_blocks').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/blocks/:id', authRequired, async (req, res) => {
  const { error } = await supabase.from('boat_blocks').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Auth: rental list ─────────────────────────────────────────
router.get('/rentals', authRequired, async (req, res) => {
  const q = supabase.from('boat_rentals').select('*').eq('site_id', req.query.site_id).order('rental_date', { ascending: true });
  if (req.query.status) q.eq('status', req.query.status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/rentals/:id', authRequired, async (req, res) => {
  const { data, error } = await supabase.from('boat_rentals').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
