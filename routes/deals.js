/**
 * GCR DEALS API
 * GET  /api/deals           — list active deals (with filters)
 * POST /api/deals/submit    — submit a deal (self-serve, goes to pending)
 * POST /api/deals/activate  — admin activates a pending deal
 * POST /api/deals/auto      — called by email parser when last-min slot detected
 * GET  /api/deals/swipe     — subset for swipe deck cards
 * GET  /api/deals/feed      — subset for Live Feed tab
 */

const express = require('express')
const router  = express.Router()
const db      = require('../db')
const { ownerRequired } = require('../middleware/ownerAuth')

// Reads and the click counter stay public — the deals feed is a tourist-facing
// surface and a click is anonymous telemetry.
//
// Posting a deal is not. The three handlers below took entity_slug straight
// from the request body, so anyone could publish a deal under any business's
// name, at any price, with their own phone number on it. They resolve the
// business from the session now, and the body's entity_slug is ignored.

// ── GET all active deals ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const {
      type,         // deal_type filter
      entity_type,  // restaurant | activity | condo | service
      today_only,   // 'true' = only is_today_only
      featured,     // 'true' = only featured
      limit = 100,
      offset = 0,
    } = req.query

    let q = db
      .from('gcr_deals')
      .select('*')
      .eq('is_active', true)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .order('is_featured', { ascending: false })
      .order('is_today_only', { ascending: false })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)

    if (type)        q = q.eq('deal_type', type)
    if (entity_type) q = q.eq('entity_type', entity_type)
    if (today_only === 'true') q = q.eq('is_today_only', true)
    if (featured   === 'true') q = q.eq('is_featured', true)

    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })

    res.json(data || [])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET deals for swipe deck ──────────────────────────────────────────────────
router.get('/swipe', async (req, res) => {
  try {
    const { data, error } = await db
      .from('gcr_deals')
      .select('id, entity_name, entity_type, entity_subtype, deal_type, headline, image_url, deal_price, price_unit, price_label, spots_remaining, is_today_only, expires_at, claim_type, claim_url, claim_phone, entity_slug')
      .eq('is_active', true)
      .eq('swipe_card', true)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .order('is_today_only', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET deals for Live Feed tab ───────────────────────────────────────────────
router.get('/feed', async (req, res) => {
  try {
    const { data, error } = await db
      .from('gcr_deals')
      .select('id, entity_name, entity_type, entity_subtype, deal_type, headline, deal_price, price_label, spots_remaining, is_today_only, expires_at, entity_slug, created_at')
      .eq('is_active', true)
      .eq('promoted_feed', true)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST self-serve deal submission ──────────────────────────────────────────
router.post('/submit', ownerRequired, async (req, res) => {
  try {
    const {
      entity_name, entity_type, entity_subtype,
      deal_type, headline, description, image_url,
      original_price, deal_price, price_unit, price_label,
      valid_date, valid_start_time, valid_end_time,
      expires_at, is_today_only, spots_total, spots_remaining,
      claim_type, claim_url, claim_phone, claim_text,
      poster_name, poster_phone,
      source = 'self_serve',
    } = req.body

    // Whose deal this is comes from the session, never the body.
    const entity_slug = req.entitySlug

    // Basic validation
    if (!entity_name) return res.status(400).json({ error: 'entity_name required' })
    if (!headline)    return res.status(400).json({ error: 'headline required' })
    if (!deal_type)   return res.status(400).json({ error: 'deal_type required' })
    if (!poster_phone) return res.status(400).json({ error: 'poster_phone required for verification' })

    // Compute discount_pct
    let discount_pct = null
    if (original_price && deal_price) {
      discount_pct = Math.round((1 - parseFloat(deal_price) / parseFloat(original_price)) * 100)
    }

    // Self-serve deals start as active=false, pending verification
    // Admin or auto-verify logic can set them active
    const { data, error } = await db
      .from('gcr_deals')
      .insert({
        entity_slug:     entity_slug || null,
        entity_name,
        entity_type:     entity_type || null,
        entity_subtype:  entity_subtype || null,
        posted_by:       poster_phone ? 'individual' : 'business',
        poster_name:     poster_name || null,
        poster_phone:    poster_phone || null,
        poster_verified: false,
        deal_type,
        headline,
        description:     description || null,
        image_url:       image_url || null,
        original_price:  original_price ? parseFloat(original_price) : null,
        deal_price:      deal_price ? parseFloat(deal_price) : null,
        price_unit:      price_unit || null,
        price_label:     price_label || null,
        discount_pct,
        valid_date:      valid_date || null,
        valid_start_time: valid_start_time || null,
        valid_end_time:  valid_end_time || null,
        expires_at:      expires_at || null,
        is_today_only:   !!is_today_only,
        spots_total:     spots_total ? parseInt(spots_total) : null,
        spots_remaining: spots_remaining ? parseInt(spots_remaining) : null,
        claim_type:      claim_type || 'phone',
        claim_url:       claim_url || null,
        claim_phone:     claim_phone || null,
        claim_text:      claim_text || null,
        is_active:       false, // pending verification
        is_featured:     false,
        promoted_sms:    false,
        promoted_feed:   false,
        swipe_card:      true,
        source,
        created_at:      new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error) return res.status(500).json({ error: error.message })

    // TODO: trigger SMS verification text to poster_phone
    // await sendSmsVerification(poster_phone, data.id)

    res.json({
      success: true,
      deal_id: data.id,
      message: 'Deal submitted — pending quick verification before going live',
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST auto-deal from email parser ─────────────────────────────────────────
// Called internally when email parser detects a cancellation or last-min slot
router.post('/auto', ownerRequired, async (req, res) => {
  try {
    const {
      entity_name, entity_type, entity_subtype,
      headline, description, deal_price, original_price, price_unit,
      spots_remaining, spots_total, valid_date, valid_start_time,
      source_log_id, claim_phone, claim_url,
    } = req.body

    // Whose deal this is comes from the session, never the body. When the
    // email parser is wired up to call this server-to-server it will need a
    // scoped API key (see Part 9), not a slug it can name for itself.
    const entity_slug = req.entitySlug

    if (!headline) {
      return res.status(400).json({ error: 'headline required' })
    }

    // Auto-deals go live immediately (verified by email parser = trusted source)
    const expires_at = valid_date
      ? new Date(valid_date + 'T23:59:00').toISOString()
      : new Date(Date.now() + 24 * 3600000).toISOString()

    const discount_pct = (original_price && deal_price)
      ? Math.round((1 - parseFloat(deal_price) / parseFloat(original_price)) * 100)
      : null

    // Get business image from entity table
    const { data: ent } = await db
      .from('entity')
      .select('hero_image_url, phone, booking_url')
      .eq('slug', entity_slug)
      .maybeSingle()

    const { data, error } = await db
      .from('gcr_deals')
      .insert({
        entity_slug,
        entity_name,
        entity_type:    entity_type || null,
        entity_subtype: entity_subtype || null,
        posted_by:      'auto',
        deal_type:      'last_minute',
        headline,
        description:    description || null,
        image_url:      ent?.hero_image_url || null,
        original_price: original_price ? parseFloat(original_price) : null,
        deal_price:     deal_price ? parseFloat(deal_price) : null,
        price_unit:     price_unit || 'person',
        discount_pct,
        valid_date:     valid_date || null,
        valid_start_time: valid_start_time || null,
        expires_at,
        is_today_only:  valid_date === new Date().toISOString().slice(0,10),
        spots_total:    spots_total ? parseInt(spots_total) : null,
        spots_remaining: spots_remaining ? parseInt(spots_remaining) : null,
        claim_type:     claim_url ? 'link' : 'phone',
        claim_url:      claim_url || ent?.booking_url || null,
        claim_phone:    claim_phone || ent?.phone || null,
        is_active:      true,
        is_featured:    false,
        promoted_feed:  true,
        swipe_card:     true,
        source:         'email_parser',
        source_log_id:  source_log_id || null,
        created_at:     new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error) return res.status(500).json({ error: error.message })

    // Auto-trigger SMS blast if less than 3 spots
    const spotsNum = spots_remaining ? parseInt(spots_remaining) : null
    if (spotsNum !== null && spotsNum <= 3) {
      // TODO: trigger SMS blast
      await db.from('gcr_deals').update({ promoted_sms: true }).eq('id', data.id)
      // await sendSmsBlast(`🔥 Last min deal: ${headline} — ${entity_name}`)
    }

    res.json({ success: true, deal_id: data.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST admin activate a pending deal ────────────────────────────────────────
router.post('/activate/:id', ownerRequired, async (req, res) => {
  try {
    const { id } = req.params
    const { blast_sms = false, feature = false } = req.body

    const { error } = await db
      .from('gcr_deals')
      .update({
        is_active:       true,
        poster_verified: true,
        is_featured:     !!feature,
        promoted_feed:   true,
        promoted_sms:    !!blast_sms,
        sms_blast_at:    blast_sms ? new Date().toISOString() : null,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', id)

    if (error) return res.status(500).json({ error: error.message })

    // TODO: if blast_sms, send SMS to loyalty list

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST track a click on a deal ──────────────────────────────────────────────
router.post('/:id/click', async (req, res) => {
  try {
    const { id } = req.params
    await db.rpc('increment_deal_clicks', { deal_id: id }).catch(() => {
      // fallback if rpc doesn't exist
      return db.from('gcr_deals').update({ click_count: db.raw('click_count + 1') }).eq('id', id)
    })
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false })
  }
})

module.exports = router
