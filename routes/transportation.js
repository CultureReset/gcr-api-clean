// ============================================================
// GCR Transportation — brokered pickup/drop-off dispatch
// Any booking (charter, hotel, restaurant, luggage) can attach a
// transportation request as an add-on. GCR brokers it out via SMS
// rotation to registered providers (drivers, taxi companies, Luggo-style
// services) who bid; the customer confirms; GCR takes a platform cut.
//
// Ported from the earlier routes/rides.js draft — same proven dispatch
// logic, rebuilt on entity_slug instead of the legacy site_id convention
// so it's consistent with the rest of the platform.
// ============================================================

const express = require('express');
const db = require('../db');
const router = express.Router();
const { sendSms, normalizePhone } = require('../utils/sms');
const { ownerRequired } = require('../middleware/ownerAuth');

// Two audiences in one file, and only one of them is signed in.
//
// The customer half — POST /request, the inbound SMS webhook, the expiry
// sweep — is public by necessity: it runs on tourists' phones and on Twilio's
// callbacks, neither of which has a session.
//
// The business half below it — a company's driver roster and its brokering
// settings — is ownerRequired. It resolves the business from the session,
// which is also what makes it work at all: it used to call resolveEntity(),
// which reads req.userId, and nothing on this router ever set that.

const DISPATCH_TIMEOUT_MINS = 5;
const GCR_CUT = 0.10; // 10% platform fee

function fmtDate(dateStr, window) {
  if (!dateStr) return window || '';
  const d = new Date(dateStr + 'T12:00:00');
  const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return window ? `${label}, ${window}` : label;
}

// ─────────────────────────────────────────────────────────────
// DISPATCH ROTATION
// ─────────────────────────────────────────────────────────────
async function dispatchToNext(requestId) {
  const { data: request } = await db.from('transportation_requests').select('*').eq('id', requestId).single();
  if (!request || request.status !== 'pending') return;

  const { data: tried } = await db.from('transportation_dispatches').select('provider_entity_slug').eq('request_id', requestId);
  const triedSlugs = (tried || []).map(d => d.provider_entity_slug);

  const capabilityCol = request.request_type === 'luggage' ? 'handles_luggage' : 'handles_passengers';

  const { data: entities } = await db
    .from('entity')
    .select('slug, name, phone')
    .eq('offers_transportation', true)
    .eq('is_active', true)
    .not('slug', 'in', `(${triedSlugs.length ? triedSlugs.map(s => `"${s}"`).join(',') : '""'})`);

  if (!entities || !entities.length) {
    await db.from('transportation_requests').update({ status: 'no_coverage' }).eq('id', requestId);
    await sendSms(request.customer_phone, "Sorry, we couldn't find an available driver for your request right now. Please try again or call the business directly.", request.linked_entity_slug || 'gcr', 'transport_no_coverage', requestId).catch(() => {});
    return;
  }

  // Pick the entity least-recently dispatched to, among their available providers with a driver that fits
  let chosen = null, chosenProvider = null;
  for (const ent of entities) {
    const { data: providers } = await db
      .from('transportation_providers')
      .select('*')
      .eq('entity_slug', ent.slug)
      .eq(capabilityCol, true)
      .eq('available', true)
      .eq('active', true)
      .gte('capacity', request.passengers || 1)
      .order('last_dispatch_at', { ascending: true, nullsFirst: true })
      .limit(1);
    if (providers && providers.length) { chosen = ent; chosenProvider = providers[0]; break; }
  }

  if (!chosen) {
    await db.from('transportation_requests').update({ status: 'no_coverage' }).eq('id', requestId);
    await sendSms(request.customer_phone, "Sorry, we couldn't find an available driver for your request right now. Please try again or call the business directly.", request.linked_entity_slug || 'gcr', 'transport_no_coverage', requestId).catch(() => {});
    return;
  }

  const expiresAt = new Date(Date.now() + DISPATCH_TIMEOUT_MINS * 60 * 1000).toISOString();

  await db.from('transportation_dispatches').insert({
    request_id: requestId,
    provider_entity_slug: chosen.slug,
    provider_id: chosenProvider.id,
    driver_phone: chosenProvider.phone,
    status: 'pending',
    expires_at: expiresAt,
  });

  await db.from('transportation_requests').update({ status: 'dispatched' }).eq('id', requestId);
  await db.from('transportation_providers').update({ last_dispatch_at: new Date().toISOString() }).eq('id', chosenProvider.id);

  const vehicle = [chosenProvider.vehicle_color, chosenProvider.vehicle_make, chosenProvider.vehicle_model].filter(Boolean).join(' ');
  const plate = chosenProvider.vehicle_plate ? ` (${chosenProvider.vehicle_plate})` : '';
  const when = fmtDate(request.pickup_date, request.pickup_window);
  const bagLine = request.request_type === 'luggage' && request.bag_count ? `\nBags: ${request.bag_count}` : '';

  const msg = `🚗 GCR TRANSPORT REQUEST\n${when}\nPickup: ${request.pickup_location}\nDrop: ${request.dropoff_location}${bagLine}${request.notes ? '\nNote: ' + request.notes : ''}\n\nReply with your price (e.g. "40") or reply PASS. You have ${DISPATCH_TIMEOUT_MINS} min.`;
  await sendSms(chosenProvider.phone, msg, chosen.slug, 'transport_dispatch', requestId);
}

// ─────────────────────────────────────────────────────────────
// POST /api/transportation/request — create a request, standalone or
// as an add-on to an existing booking (pass linked_booking_id).
// ─────────────────────────────────────────────────────────────
router.post('/request', async (req, res) => {
  try {
    const {
      customer_name, customer_phone, request_type = 'passenger',
      pickup_location, dropoff_location, pickup_date, pickup_window,
      passengers, bag_count, notes, linked_booking_id, linked_entity_slug, source = 'direct',
    } = req.body || {}

    if (!customer_phone || !pickup_location || !dropoff_location) {
      return res.status(400).json({ error: 'customer_phone, pickup_location, dropoff_location required' })
    }
    const phone = normalizePhone(customer_phone)
    if (!phone) return res.status(400).json({ error: 'Invalid phone number' })

    const { data: request, error } = await db.from('transportation_requests').insert({
      source,
      linked_booking_id: linked_booking_id || null,
      linked_entity_slug: linked_entity_slug || null,
      customer_name: customer_name || null,
      customer_phone: phone,
      request_type,
      pickup_location, dropoff_location,
      pickup_date: pickup_date || null,
      pickup_window: pickup_window || null,
      passengers: parseInt(passengers) || 1,
      bag_count: bag_count || null,
      notes: notes || null,
      status: 'pending',
    }).select().single()

    if (error) return res.status(500).json({ error: error.message })

    dispatchToNext(request.id).catch(e => console.error('Dispatch error:', e.message))

    res.json({ success: true, request_id: request.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────
// POST /api/transportation/inbound-sms — Twilio webhook
// Driver bids/PASS + customer YES/NO, same flow proven in the rides.js draft
// ─────────────────────────────────────────────────────────────
router.post('/inbound-sms', express.urlencoded({ extended: false }), async (req, res) => {
  const from = normalizePhone(req.body.From || req.body.from || '')
  const raw = (req.body.Body || req.body.body || '').trim()
  const body = raw.toLowerCase()

  res.set('Content-Type', 'text/xml')
  res.send('<Response></Response>')
  if (!from) return

  const { data: pendingDispatch } = await db
    .from('transportation_dispatches')
    .select('*, transportation_requests(*)')
    .eq('driver_phone', from)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('dispatched_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (pendingDispatch) {
    const request = pendingDispatch.transportation_requests

    if (body === 'pass') {
      await db.from('transportation_dispatches').update({ status: 'passed', responded_at: new Date().toISOString() }).eq('id', pendingDispatch.id)
      await db.from('transportation_requests').update({ status: 'pending' }).eq('id', request.id)
      await sendSms(from, 'Got it — passed on this request.', pendingDispatch.provider_entity_slug, 'transport_driver_pass', request.id)
      dispatchToNext(request.id).catch(() => {})
      return
    }

    const price = parseFloat(raw.replace(/[^0-9.]/g, ''))
    if (!isNaN(price) && price > 0) {
      await db.from('transportation_dispatches').update({ status: 'bid_received', bid_amount: price, responded_at: new Date().toISOString() }).eq('id', pendingDispatch.id)

      const { data: provider } = await db.from('transportation_providers').select('driver_name, vehicle_color, vehicle_make, vehicle_model, vehicle_plate').eq('id', pendingDispatch.provider_id).single()
      const driverName = provider?.driver_name || 'Driver'
      const vehicle = [provider?.vehicle_color, provider?.vehicle_make, provider?.vehicle_model].filter(Boolean).join(' ')
      const plate = provider?.vehicle_plate ? ` (${provider.vehicle_plate})` : ''

      const customerMsg = `🚗 Bid from ${driverName}\n${vehicle}${plate}\nPrice: $${price.toFixed(2)}\n\n${request.pickup_location} → ${request.dropoff_location}\n${fmtDate(request.pickup_date, request.pickup_window)}\n\nReply YES to confirm or NO to pass.`
      await sendSms(request.customer_phone, customerMsg, pendingDispatch.provider_entity_slug, 'transport_customer_bid', request.id)
      await sendSms(from, `✓ Bid of $${price.toFixed(2)} sent to customer. Waiting for their reply.`, pendingDispatch.provider_entity_slug, 'transport_driver_bid_ack', request.id)
      return
    }

    await sendSms(from, 'Reply with your price (e.g. "40") or PASS.', pendingDispatch.provider_entity_slug, 'transport_driver_invalid', request.id)
    return
  }

  const { data: customerRequest } = await db
    .from('transportation_requests')
    .select('*')
    .eq('customer_phone', from)
    .eq('status', 'dispatched')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (customerRequest) {
    const { data: bidDispatch } = await db
      .from('transportation_dispatches')
      .select('*, transportation_providers(*)')
      .eq('request_id', customerRequest.id)
      .eq('status', 'bid_received')
      .order('responded_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!bidDispatch) {
      await sendSms(from, "We're still finding you a driver. Hang tight!", customerRequest.linked_entity_slug || 'gcr', 'transport_customer_wait', customerRequest.id)
      return
    }

    if (body === 'yes' || body === 'y') {
      const provider = bidDispatch.transportation_providers
      const price = bidDispatch.bid_amount
      const driverEarns = (price * (1 - GCR_CUT)).toFixed(2)

      await db.from('transportation_dispatches').update({ status: 'won' }).eq('id', bidDispatch.id)
      await db.from('transportation_requests').update({ status: 'confirmed', assigned_provider_id: bidDispatch.provider_id, price }).eq('id', customerRequest.id)

      const driverName = provider?.driver_name || 'Your driver'
      const vehicle = [provider?.vehicle_color, provider?.vehicle_make, provider?.vehicle_model].filter(Boolean).join(' ')
      const plate = provider?.vehicle_plate ? ` (${provider.vehicle_plate})` : ''

      await sendSms(from, `✓ Confirmed!\n${driverName} · ${vehicle}${plate}\nPickup: ${fmtDate(customerRequest.pickup_date, customerRequest.pickup_window)}\nPrice: $${price.toFixed(2)}\n\nYour driver will send you a payment link shortly.`, bidDispatch.provider_entity_slug, 'transport_customer_confirmed', customerRequest.id)
      await sendSms(bidDispatch.driver_phone, `✓ Customer confirmed your $${price.toFixed(2)} bid!\nYou earn: $${driverEarns} (after 10% platform fee)\n\nCustomer: ${customerRequest.customer_name || 'Guest'} · ${customerRequest.customer_phone}\nPickup: ${customerRequest.pickup_location}\nDrop: ${customerRequest.dropoff_location}\n${fmtDate(customerRequest.pickup_date, customerRequest.pickup_window)}`, bidDispatch.provider_entity_slug, 'transport_driver_confirmed', customerRequest.id)
      return
    }

    if (body === 'no' || body === 'n') {
      await db.from('transportation_dispatches').update({ status: 'customer_declined' }).eq('id', bidDispatch.id)
      await db.from('transportation_requests').update({ status: 'pending' }).eq('id', customerRequest.id)
      await sendSms(from, "No problem — we'll find another driver. This may take a few minutes.", customerRequest.linked_entity_slug || 'gcr', 'transport_customer_declined', customerRequest.id)
      dispatchToNext(customerRequest.id).catch(() => {})
      return
    }

    await sendSms(from, 'Reply YES to confirm or NO to find another driver.', customerRequest.linked_entity_slug || 'gcr', 'transport_customer_invalid', customerRequest.id)
    return
  }
})

// ─────────────────────────────────────────────────────────────
// GET /api/transportation/expire — cron: expire stale dispatches, re-dispatch
// ─────────────────────────────────────────────────────────────
router.get('/expire', async (req, res) => {
  if (process.env.CRON_SECRET && (req.headers.authorization || '') !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { data: expired } = await db
    .from('transportation_dispatches')
    .select('id, request_id, driver_phone, provider_entity_slug')
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString())

  if (!expired || !expired.length) return res.json({ expired: 0 })

  let count = 0
  for (const d of expired) {
    await db.from('transportation_dispatches').update({ status: 'expired' }).eq('id', d.id)
    await sendSms(d.driver_phone, 'Your 5-minute window to respond has closed.', d.provider_entity_slug, 'transport_dispatch_expired', d.request_id).catch(() => {})
    await db.from('transportation_requests').update({ status: 'pending' }).eq('id', d.request_id).eq('status', 'dispatched')
    dispatchToNext(d.request_id).catch(() => {})
    count++
  }
  res.json({ expired: count })
})

// ─────────────────────────────────────────────────────────────
// PROVIDER MANAGEMENT — a business registers its drivers/vehicles
// ─────────────────────────────────────────────────────────────
router.get('/providers', ownerRequired, async (req, res) => {
  const entity = { slug: req.entitySlug }
  const { data, error } = await db.from('transportation_providers').select('*').eq('entity_slug', entity.slug).eq('active', true).order('driver_name')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

router.post('/providers', ownerRequired, async (req, res) => {
  const entity = { slug: req.entitySlug }

  const { driver_name, phone, vehicle_type, vehicle_make, vehicle_model, vehicle_color, vehicle_plate, capacity, handles_luggage, handles_passengers, notes } = req.body
  if (!driver_name || !phone) return res.status(400).json({ error: 'driver_name and phone required' })
  const normalized = normalizePhone(phone)
  if (!normalized) return res.status(400).json({ error: 'Invalid phone number' })

  const { data, error } = await db.from('transportation_providers').insert({
    entity_slug: entity.slug,
    driver_name, phone: normalized,
    vehicle_type: vehicle_type || 'sedan',
    vehicle_make: vehicle_make || null, vehicle_model: vehicle_model || null,
    vehicle_color: vehicle_color || null, vehicle_plate: vehicle_plate || null,
    capacity: parseInt(capacity) || 4,
    handles_luggage: !!handles_luggage,
    handles_passengers: handles_passengers !== false,
    notes: notes || null,
    available: false,
  }).select().single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.patch('/providers/:id', ownerRequired, async (req, res) => {
  const entity = { slug: req.entitySlug }

  const updates = {}
  const allowed = ['available', 'driver_name', 'phone', 'vehicle_type', 'vehicle_make', 'vehicle_model', 'vehicle_color', 'vehicle_plate', 'capacity', 'handles_luggage', 'handles_passengers', 'notes', 'active']
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k] })
  if (req.body.phone) {
    const n = normalizePhone(req.body.phone)
    if (!n) return res.status(400).json({ error: 'Invalid phone' })
    updates.phone = n
  }

  const { data, error } = await db.from('transportation_providers').update(updates).eq('id', req.params.id).eq('entity_slug', entity.slug).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.delete('/providers/:id', ownerRequired, async (req, res) => {
  const entity = { slug: req.entitySlug }
  const { error } = await db.from('transportation_providers').update({ active: false }).eq('id', req.params.id).eq('entity_slug', entity.slug)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// GET /api/transportation/company/settings — current on/off state for this business
router.get('/company/settings', ownerRequired, async (req, res) => {
  const entity = { slug: req.entitySlug }
  const { data, error } = await db.from('entity').select('slug, name, offers_transportation').eq('slug', entity.slug).maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || { offers_transportation: false })
})

// PATCH /api/transportation/company/settings — turn transportation brokering on/off for this business
router.patch('/company/settings', ownerRequired, async (req, res) => {
  const entity = { slug: req.entitySlug }
  const { offers_transportation } = req.body
  const { data, error } = await db.from('entity').update({ offers_transportation: !!offers_transportation }).eq('slug', entity.slug).select('slug, name, offers_transportation').single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// GET /api/transportation/requests — a provider's own requests (dispatched to or won by them)
router.get('/requests', ownerRequired, async (req, res) => {
  const entity = { slug: req.entitySlug }

  const { data, error } = await db
    .from('transportation_requests')
    .select('*, transportation_dispatches!inner(provider_entity_slug, status, bid_amount)')
    .eq('transportation_dispatches.provider_entity_slug', entity.slug)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

module.exports = router
