// ============================================================
// GCR Rides — SMS Dispatch Platform
// Any booking on GCR → ride lead → SMS rotation → bid → confirm → pay
// ============================================================

const express = require('express');
const { authRequired, adminRequired } = require('../middleware/auth');
const supabase = require('../db');
const router = express.Router();

const { sendSms, normalizePhone } = require('../utils/sms');

const PLATFORM_SITE_ID = 'gcr-platform';
const DISPATCH_TIMEOUT_MINS = 5;
const GCR_CUT = 0.10; // 10% platform fee

// ─────────────────────────────────────────────────────────────
// SQL — run once in CyberCheck DB
// ─────────────────────────────────────────────────────────────
/*
CREATE TABLE IF NOT EXISTS taxi_drivers (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id       text NOT NULL,
  name          text NOT NULL,
  phone         text NOT NULL,
  vehicle_type  text DEFAULT 'sedan',
  vehicle_make  text,
  vehicle_model text,
  vehicle_color text,
  vehicle_plate text,
  capacity      int  DEFAULT 4,
  notes         text,
  available     boolean DEFAULT false,
  active        boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ride_requests (
  id                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source                 text DEFAULT 'direct',
  source_booking_id      text,
  customer_name          text,
  customer_phone         text NOT NULL,
  pickup_address         text NOT NULL,
  destination            text NOT NULL,
  pickup_time            timestamptz,
  passengers             int DEFAULT 1,
  vehicle_type           text,
  notes                  text,
  status                 text DEFAULT 'pending',
  assigned_driver_id     uuid,
  assigned_company_site_id text,
  price                  numeric,
  stripe_payment_link    text,
  payment_status         text DEFAULT 'unpaid',
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ride_dispatches (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_request_id  uuid NOT NULL,
  company_site_id  text NOT NULL,
  driver_id        uuid,
  driver_phone     text,
  status           text DEFAULT 'pending',
  bid_amount       numeric,
  dispatched_at    timestamptz DEFAULT now(),
  responded_at     timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz DEFAULT now()
);

-- Track last time each taxi company received a dispatch (for fair rotation)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_dispatch_at timestamptz;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS offer_rides boolean DEFAULT false;
*/

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

async function dispatchToNext(rideId) {
  // Load the ride
  const { data: ride } = await supabase
    .from('ride_requests')
    .select('*')
    .eq('id', rideId)
    .single();

  if (!ride || ride.status !== 'pending') return;

  // Companies already tried for this ride
  const { data: tried } = await supabase
    .from('ride_dispatches')
    .select('company_site_id')
    .eq('ride_request_id', rideId);

  const triedIds = (tried || []).map(d => d.company_site_id);

  // Find next company in rotation: offer_rides = true, has available driver, longest since last dispatch
  const { data: companies } = await supabase
    .from('businesses')
    .select('site_id, name, last_dispatch_at')
    .eq('offer_rides', true)
    .eq('status', 'active')
    .order('last_dispatch_at', { ascending: true, nullsFirst: true });

  if (!companies || !companies.length) {
    await supabase.from('ride_requests').update({ status: 'no_drivers' }).eq('id', rideId);
    return;
  }

  // Skip already-tried companies
  const eligible = companies.filter(c => !triedIds.includes(c.site_id));
  if (!eligible.length) {
    await supabase.from('ride_requests').update({ status: 'no_coverage' }).eq('id', rideId);
    // SMS customer
    await sendSms(
      ride.customer_phone,
      'Sorry, we couldn\'t find an available driver for your ride right now. Please try again or call us directly.',
      PLATFORM_SITE_ID, 'ride_no_coverage', rideId
    );
    return;
  }

  const company = eligible[0];

  // Find an available driver at that company that fits capacity
  const { data: drivers } = await supabase
    .from('taxi_drivers')
    .select('id, name, phone, vehicle_type, vehicle_make, vehicle_model, vehicle_color, vehicle_plate, capacity')
    .eq('site_id', company.site_id)
    .eq('available', true)
    .eq('active', true)
    .gte('capacity', ride.passengers || 1)
    .order('capacity', { ascending: true }); // smallest fit first

  if (!drivers || !drivers.length) {
    // Skip this company — no available driver
    triedIds.push(company.site_id);
    const nextEligible = companies.filter(c => !triedIds.includes(c.site_id));
    if (nextEligible.length) return dispatchToNext(rideId);
    await supabase.from('ride_requests').update({ status: 'no_coverage' }).eq('id', rideId);
    return;
  }

  const driver = drivers[0];
  const expiresAt = new Date(Date.now() + DISPATCH_TIMEOUT_MINS * 60 * 1000).toISOString();

  // Create dispatch record
  const { data: dispatch } = await supabase
    .from('ride_dispatches')
    .insert({
      ride_request_id: rideId,
      company_site_id: company.site_id,
      driver_id: driver.id,
      driver_phone: driver.phone,
      status: 'pending',
      expires_at: expiresAt,
    })
    .select()
    .single();

  // Update ride status
  await supabase.from('ride_requests').update({ status: 'dispatched' }).eq('id', rideId);

  // Update company last_dispatch_at
  await supabase.from('businesses').update({ last_dispatch_at: new Date().toISOString() }).eq('site_id', company.site_id);

  // Build SMS to driver
  const pax = ride.passengers || 1;
  const time = fmtTime(ride.pickup_time);
  const vehicle = [driver.vehicle_color, driver.vehicle_make, driver.vehicle_model].filter(Boolean).join(' ');
  const plate = driver.vehicle_plate ? ` (${driver.vehicle_plate})` : '';

  const msg = `🚗 GCR RIDE REQUEST\n${pax} pax · ${time}\nPickup: ${ride.pickup_address}\nDrop: ${ride.destination}${ride.notes ? '\nNote: ' + ride.notes : ''}\n\nReply with your price (e.g. "40") or reply PASS. You have ${DISPATCH_TIMEOUT_MINS} min.`;

  await sendSms(driver.phone, msg, PLATFORM_SITE_ID, 'ride_dispatch', rideId);
}

// ─────────────────────────────────────────────────────────────
// POST /api/rides/request — create ride lead from any source
// Called by booking confirmations, booking pages, direct requests
// ─────────────────────────────────────────────────────────────
router.post('/request', async (req, res) => {
  const {
    customer_name, customer_phone, pickup_address, destination,
    pickup_time, passengers, vehicle_type, notes,
    source = 'direct', source_booking_id
  } = req.body;

  if (!customer_phone || !pickup_address || !destination) {
    return res.status(400).json({ error: 'customer_phone, pickup_address, destination required' });
  }

  const phone = normalizePhone(customer_phone);
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });

  const { data: ride, error } = await supabase
    .from('ride_requests')
    .insert({
      source,
      source_booking_id: source_booking_id || null,
      customer_name: customer_name || null,
      customer_phone: phone,
      pickup_address,
      destination,
      pickup_time: pickup_time || null,
      passengers: parseInt(passengers) || 1,
      vehicle_type: vehicle_type || null,
      notes: notes || null,
      status: 'pending',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Fire dispatch async — don't block response
  dispatchToNext(ride.id).catch(e => console.error('Dispatch error:', e.message));

  res.json({ ok: true, ride_id: ride.id });
});

// ─────────────────────────────────────────────────────────────
// POST /api/rides/inbound-sms — Twilio webhook
// Handles driver bids/PASS + customer YES/NO confirmations
// ─────────────────────────────────────────────────────────────
router.post('/inbound-sms', async (req, res) => {
  const from = normalizePhone(req.body.From || req.body.from || '');
  const raw  = (req.body.Body || req.body.body || '').trim();
  const body = raw.toLowerCase();

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  if (!from) return;

  // ── Is this a DRIVER responding to a dispatch? ──
  const { data: pendingDispatch } = await supabase
    .from('ride_dispatches')
    .select('*, ride_requests(*)')
    .eq('driver_phone', from)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('dispatched_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pendingDispatch) {
    const ride = pendingDispatch.ride_requests;

    if (body === 'pass') {
      // Driver passed — mark dispatch, try next company
      await supabase
        .from('ride_dispatches')
        .update({ status: 'passed', responded_at: new Date().toISOString() })
        .eq('id', pendingDispatch.id);

      await supabase
        .from('ride_requests')
        .update({ status: 'pending' })
        .eq('id', ride.id);

      await sendSms(from, 'Got it — passed on this ride.', PLATFORM_SITE_ID, 'ride_driver_pass', ride.id);
      dispatchToNext(ride.id).catch(() => {});
      return;
    }

    // Try to parse as a price
    const price = parseFloat(raw.replace(/[^0-9.]/g, ''));
    if (!isNaN(price) && price > 0) {
      // Driver bid — lock this dispatch with bid
      await supabase
        .from('ride_dispatches')
        .update({ status: 'bid_received', bid_amount: price, responded_at: new Date().toISOString() })
        .eq('id', pendingDispatch.id);

      // Pull driver info for customer SMS
      const { data: driver } = await supabase
        .from('taxi_drivers')
        .select('name, vehicle_color, vehicle_make, vehicle_model, vehicle_plate')
        .eq('id', pendingDispatch.driver_id)
        .single();

      const driverName = driver?.name || 'Driver';
      const vehicle = [driver?.vehicle_color, driver?.vehicle_make, driver?.vehicle_model].filter(Boolean).join(' ');
      const plate = driver?.vehicle_plate ? ` (${driver.vehicle_plate})` : '';

      const customerMsg = `🚗 Ride bid from ${driverName}\n${vehicle}${plate}\nPrice: $${price.toFixed(2)}\n\nPickup: ${ride.pickup_address} → ${ride.destination}\n${fmtTime(ride.pickup_time)}\n\nReply YES to confirm or NO to pass.`;

      await sendSms(ride.customer_phone, customerMsg, PLATFORM_SITE_ID, 'ride_customer_bid', ride.id);
      await sendSms(from, `✓ Bid of $${price.toFixed(2)} sent to customer. Waiting for their reply.`, PLATFORM_SITE_ID, 'ride_driver_bid_ack', ride.id);
      return;
    }

    await sendSms(from, 'Reply with your price (e.g. "40") or PASS.', PLATFORM_SITE_ID, 'ride_driver_invalid', ride.id);
    return;
  }

  // ── Is this a CUSTOMER confirming a bid? ──
  const { data: customerRide } = await supabase
    .from('ride_requests')
    .select('*')
    .eq('customer_phone', from)
    .eq('status', 'dispatched')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (customerRide) {
    // Find the bid_received dispatch for this ride
    const { data: bidDispatch } = await supabase
      .from('ride_dispatches')
      .select('*, taxi_drivers(*)')
      .eq('ride_request_id', customerRide.id)
      .eq('status', 'bid_received')
      .order('responded_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!bidDispatch) {
      await sendSms(from, 'We\'re still finding you a driver. Hang tight!', PLATFORM_SITE_ID, 'ride_customer_wait', customerRide.id);
      return;
    }

    if (body === 'yes' || body === 'y') {
      const driver      = bidDispatch.taxi_drivers;
      const price       = bidDispatch.bid_amount;
      const priceInCents = Math.round(price * 100);
      const feeCents    = Math.round(priceInCents * GCR_CUT);
      const driverEarns = (price * (1 - GCR_CUT)).toFixed(2);

      // Confirm ride
      await supabase
        .from('ride_dispatches')
        .update({ status: 'won' })
        .eq('id', bidDispatch.id);

      await supabase
        .from('ride_requests')
        .update({
          status: 'confirmed',
          assigned_driver_id: bidDispatch.driver_id,
          assigned_company_site_id: bidDispatch.company_site_id,
          price: price,
        })
        .eq('id', customerRide.id);

      const driverName = driver?.name || 'Your driver';
      const vehicle    = [driver?.vehicle_color, driver?.vehicle_make, driver?.vehicle_model].filter(Boolean).join(' ');
      const plate      = driver?.vehicle_plate ? ` (${driver.vehicle_plate})` : '';

      // ── Generate Stripe payment link via driver's connected account ──
      let paymentLink = null;
      try {
        const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

        if (stripe) {
          // Look up taxi company's connected Stripe account
          const { data: conn } = await supabase
            .from('connections')
            .select('account_id')
            .eq('site_id', bidDispatch.company_site_id)
            .eq('provider', 'stripe')
            .eq('status', 'connected')
            .maybeSingle();

          if (conn?.account_id) {
            // Create a price object on the connected account
            const routeDesc = `Ride: ${customerRide.pickup_address} → ${customerRide.destination}`;
            const pl = await stripe.paymentLinks.create({
              line_items: [{
                price_data: {
                  currency: 'usd',
                  unit_amount: priceInCents,
                  product_data: { name: routeDesc },
                },
                quantity: 1,
              }],
              application_fee_amount: feeCents,
              transfer_data: { destination: conn.account_id },
              metadata: {
                ride_request_id: customerRide.id,
                driver_id: bidDispatch.driver_id || '',
                customer_phone: customerRide.customer_phone,
              },
            });
            paymentLink = pl.url;

            // Save link to ride record
            await supabase
              .from('ride_requests')
              .update({ stripe_payment_link: paymentLink })
              .eq('id', customerRide.id);
          }
        }
      } catch (e) {
        console.error('Stripe payment link error:', e.message);
      }

      // Customer SMS — include payment link if generated
      const payLine = paymentLink
        ? `\n\n💳 Pay here: ${paymentLink}`
        : `\n\nYour driver will send you a payment link shortly.`;

      await sendSms(
        from,
        `✓ Ride confirmed!\n${driverName} · ${vehicle}${plate}\nPickup: ${fmtTime(customerRide.pickup_time)}\nPrice: $${price.toFixed(2)}${payLine}`,
        PLATFORM_SITE_ID, 'ride_customer_confirmed', customerRide.id
      );

      // Driver SMS
      await sendSms(
        bidDispatch.driver_phone,
        `✓ Customer confirmed your $${price.toFixed(2)} bid!\nYou earn: $${driverEarns} (after 10% platform fee)\n\nCustomer: ${customerRide.customer_name || 'Guest'} · ${customerRide.customer_phone}\nPickup: ${customerRide.pickup_address}\nDrop: ${customerRide.destination}\n${fmtTime(customerRide.pickup_time)}${paymentLink ? '\n\nPayment link sent to customer ✓' : ''}`,
        PLATFORM_SITE_ID, 'ride_driver_confirmed', customerRide.id
      );
      return;
    }

    if (body === 'no' || body === 'n') {
      // Customer declined this bid
      await supabase
        .from('ride_dispatches')
        .update({ status: 'customer_declined' })
        .eq('id', bidDispatch.id);

      await supabase
        .from('ride_requests')
        .update({ status: 'pending' })
        .eq('id', customerRide.id);

      await sendSms(from, 'No problem — we\'ll find another driver for you. This may take a few minutes.', PLATFORM_SITE_ID, 'ride_customer_declined', customerRide.id);
      dispatchToNext(customerRide.id).catch(() => {});
      return;
    }

    await sendSms(from, 'Reply YES to confirm your ride or NO to find another driver.', PLATFORM_SITE_ID, 'ride_customer_invalid', customerRide.id);
    return;
  }

  // Unknown sender — no active ride context
  await sendSms(from, 'Hi! To request a ride visit gulfcoastradar.com or contact us directly.', PLATFORM_SITE_ID, 'ride_unknown', null);
});

// ─────────────────────────────────────────────────────────────
// GET /api/rides/expire — cron: expire stale dispatches and re-dispatch
// Schedule: every minute  "* * * * *"
// ─────────────────────────────────────────────────────────────
router.get('/expire', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Find pending dispatches that have passed their timeout
  const { data: expired } = await supabase
    .from('ride_dispatches')
    .select('id, ride_request_id, driver_phone, company_site_id')
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString());

  if (!expired || !expired.length) return res.json({ expired: 0 });

  let count = 0;
  for (const d of expired) {
    await supabase
      .from('ride_dispatches')
      .update({ status: 'expired' })
      .eq('id', d.id);

    // Tell driver their window closed
    await sendSms(
      d.driver_phone,
      'Your 5-minute window to respond to that ride has closed.',
      PLATFORM_SITE_ID, 'ride_dispatch_expired', d.ride_request_id
    ).catch(() => {});

    // Reset ride to pending and try next company
    await supabase
      .from('ride_requests')
      .update({ status: 'pending' })
      .eq('id', d.ride_request_id)
      .eq('status', 'dispatched');

    dispatchToNext(d.ride_request_id).catch(() => {});
    count++;
  }

  res.json({ expired: count });
});

// ─────────────────────────────────────────────────────────────
// DRIVER MANAGEMENT
// ─────────────────────────────────────────────────────────────

// GET /api/rides/drivers — list drivers for a company
router.get('/drivers', authRequired, async (req, res) => {
  const siteId = req.query.site_id || req.siteId;
  const { data, error } = await supabase
    .from('taxi_drivers')
    .select('*')
    .eq('site_id', siteId)
    .eq('active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/rides/drivers — add a driver
router.post('/drivers', authRequired, async (req, res) => {
  const siteId = req.body.site_id || req.siteId;
  const { name, phone, vehicle_type, vehicle_make, vehicle_model, vehicle_color, vehicle_plate, capacity, notes } = req.body;

  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
  const normalized = normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: 'Invalid phone number' });

  const { data, error } = await supabase
    .from('taxi_drivers')
    .insert({
      site_id: siteId,
      name,
      phone: normalized,
      vehicle_type: vehicle_type || 'sedan',
      vehicle_make: vehicle_make || null,
      vehicle_model: vehicle_model || null,
      vehicle_color: vehicle_color || null,
      vehicle_plate: vehicle_plate || null,
      capacity: parseInt(capacity) || 4,
      notes: notes || null,
      available: false,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/rides/drivers/:id — update driver (availability toggle, details)
router.patch('/drivers/:id', authRequired, async (req, res) => {
  const { id } = req.params;
  const updates = {};
  const allowed = ['available', 'name', 'phone', 'vehicle_type', 'vehicle_make', 'vehicle_model', 'vehicle_color', 'vehicle_plate', 'capacity', 'notes', 'active'];
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (req.body.phone) {
    const n = normalizePhone(req.body.phone);
    if (!n) return res.status(400).json({ error: 'Invalid phone' });
    updates.phone = n;
  }

  const { data, error } = await supabase
    .from('taxi_drivers')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/rides/drivers/:id — deactivate
router.delete('/drivers/:id', authRequired, async (req, res) => {
  const { error } = await supabase
    .from('taxi_drivers')
    .update({ active: false })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// RIDE REQUESTS — admin / company views
// ─────────────────────────────────────────────────────────────

// GET /api/rides — list rides (filtered by site_id = taxi company, or all for admin)
router.get('/', authRequired, async (req, res) => {
  const { status, limit = 50 } = req.query;
  let q = supabase
    .from('ride_requests')
    .select('*, ride_dispatches(id, company_site_id, driver_id, status, bid_amount, dispatched_at)')
    .order('created_at', { ascending: false })
    .limit(parseInt(limit));

  if (status) q = q.eq('status', status);
  if (req.role !== 'admin') q = q.eq('assigned_company_site_id', req.siteId);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/rides/stats — earnings + activity for a company
router.get('/stats', authRequired, async (req, res) => {
  const siteId = req.query.site_id || req.siteId;

  const { data: rides } = await supabase
    .from('ride_requests')
    .select('price, status, created_at')
    .eq('assigned_company_site_id', siteId);

  const allRides   = rides || [];
  const today      = new Date().toISOString().slice(0, 10);
  const todayRides = allRides.filter(r => r.created_at?.slice(0, 10) === today);
  const completed  = allRides.filter(r => r.status === 'completed');

  const earnings = (rides) => rides.filter(r => r.status === 'completed').reduce((sum, r) => sum + (r.price || 0) * (1 - GCR_CUT), 0);

  res.json({
    total_rides:     allRides.length,
    today_rides:     todayRides.length,
    completed_rides: completed.length,
    total_earnings:  earnings(allRides).toFixed(2),
    today_earnings:  earnings(todayRides).toFixed(2),
  });
});

// PATCH /api/rides/:id — update ride status (en_route, completed, cancelled)
router.patch('/:id', authRequired, async (req, res) => {
  const allowed = ['status', 'price', 'notes', 'stripe_payment_link', 'payment_status'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  const { data, error } = await supabase
    .from('ride_requests')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─────────────────────────────────────────────────────────────
// COMPANY SETTINGS (offer_rides toggle)
// ─────────────────────────────────────────────────────────────

// PATCH /api/rides/company/settings
router.patch('/company/settings', authRequired, async (req, res) => {
  const siteId = req.body.site_id || req.siteId;
  const { offer_rides } = req.body;
  const { data, error } = await supabase
    .from('businesses')
    .update({ offer_rides })
    .eq('site_id', siteId)
    .select('site_id, name, offer_rides, last_dispatch_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
