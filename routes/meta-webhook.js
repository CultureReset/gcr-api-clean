/**
 * Meta Webhook — Instagram & Facebook
 * ─────────────────────────────────────
 * Mounted at: /api/meta-webhook
 *
 * Two endpoints:
 *   GET  /api/meta-webhook   — Meta verification handshake (one-time setup)
 *   POST /api/meta-webhook   — Live event receiver (new posts, comments, etc.)
 *
 * Setup in Meta Developer Console:
 *   1. Create a Facebook App at developers.facebook.com
 *   2. Add "Webhooks" product
 *   3. Set callback URL → https://gcr-api-clean.vercel.app/api/meta-webhook
 *   4. Set verify token → value of META_WEBHOOK_VERIFY_TOKEN env var
 *   5. Subscribe to: instagram → media, facebook → feed
 *   6. Set META_APP_SECRET env var (from App Settings > Basic)
 *
 * Env vars needed:
 *   META_WEBHOOK_VERIFY_TOKEN  — any string you choose, set it in Meta dashboard too
 *   META_APP_SECRET            — from Meta App Settings > Basic
 */

const express = require('express')
const crypto  = require('crypto')
const router  = express.Router()
const { createClient } = require('@supabase/supabase-js')
const { callAI } = require('../utils/ai-provider')

// GCR_SUPABASE_* is what the rest of the API — and the deployment — actually
// sets. This file was the only one reading SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY, a name that appears nowhere else and is not in
// .env.example, so createClient threw on load and server.js's fail-safe mount
// skipped the whole router with only a console warning: every Meta webhook
// delivery 404'd. The bare names stay as fallbacks for anyone who set them.
const db = createClient(
  process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SERVICE_KEY
)

// ── GET /api/meta-webhook — Meta verification handshake ───────────────────────
// Meta hits this once when you register the webhook URL.
// It sends hub.challenge — you echo it back to confirm ownership.
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('[meta-webhook] Verification handshake OK')
    return res.status(200).send(challenge)
  }
  console.warn('[meta-webhook] Verification failed — token mismatch or wrong mode')
  res.sendStatus(403)
})

// ── POST /api/meta-webhook — Live event receiver ──────────────────────────────
// Verify the signature, then process whatever Meta sends.
// Always return 200 fast — Meta will retry if it times out.
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  res.sendStatus(200) // Always ack fast — processing happens async below

  // Verify signature so only Meta can send us events
  const sig = req.headers['x-hub-signature-256']
  if (sig && process.env.META_APP_SECRET) {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', process.env.META_APP_SECRET)
      .update(req.body)
      .digest('hex')
    if (sig !== expected) {
      console.warn('[meta-webhook] Signature mismatch — ignoring')
      return
    }
  }

  let payload
  try {
    payload = JSON.parse(req.body.toString())
  } catch (e) {
    console.error('[meta-webhook] Bad JSON:', e.message)
    return
  }

  const { object, entry } = payload
  if (!entry?.length) return

  // Process each entry — Meta batches multiple events per POST
  for (const ev of entry) {
    try {
      if (object === 'instagram') {
        await handleInstagram(ev)
      } else if (object === 'page') {
        await handleFacebook(ev)
      }
    } catch (err) {
      console.error('[meta-webhook] Handler error:', err.message)
    }
  }
})

// ── Claude post analyzer ──────────────────────────────────────────────────────
// One call does three things: classifies the image, extracts any hours change,
// and decides whether the image should be saved to the business gallery.
async function analyzePost({ caption, imageUrl, entitySlug }) {
  try {
    const prompt = `You are analyzing a social media post from a local Gulf Coast business.

Business slug: ${entitySlug || 'unknown'}
Caption: ${caption || '(no caption)'}
Image URL: ${imageUrl || '(no image)'}

Respond with ONLY a JSON object, no markdown, no explanation:
{
  "photo_type": "food" | "exterior" | "interior" | "outdoor" | "event" | "other" | null,
  "save_to_gallery": true | false,
  "gallery_title": "short descriptive title if saving, else null",
  "hours_change": true | false,
  "hours": {
    "date": "YYYY-MM-DD or null if not today/tomorrow",
    "closed": true | false,
    "open_time": "HH:MM or null",
    "close_time": "HH:MM or null",
    "note": "plain english summary of the change"
  } | null
}

Rules:
- save_to_gallery = true only if there is an image AND photo_type is food, exterior, interior, or outdoor
- food = any dish, drink, plate, menu item
- hours_change = true only if caption explicitly mentions opening late, closing early, closed today/tomorrow, or special hours
- For hours.date: "today" means ${new Date().toISOString().split('T')[0]}, "tomorrow" means ${new Date(Date.now() + 86400000).toISOString().split('T')[0]}
- All times in 24h format`

    const text = await callAI('post_analysis', prompt, {
      maxTokens: 512,
      systemPrompt: 'You analyze social media posts for a local business discovery platform. Always respond with valid JSON only.',
      imageUrl,
    })
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch (e) {
    console.error('[meta-webhook] Post analysis failed:', e.message)
    return null
  }
}

// Apply analysis results — save image to gallery and/or update hours
async function applyAnalysis(analysis, { entitySlug, imageUrl, postUrl }) {
  if (!analysis || !entitySlug) return

  // 1. Save image to entity_photos gallery
  if (analysis.save_to_gallery && imageUrl) {
    await db.from('entity_photos').insert({
      entity_slug:   entitySlug,
      url:           imageUrl,
      photo_type:    analysis.photo_type,
      title:         analysis.gallery_title || null,
      source_name:   'Social Media Post',
      source_page_url: postUrl || null,
      usage_note:    'social_auto_saved',
      is_cover:      false,
      sort_order:    999, // goes to end of gallery, business can reorder
    })
    console.log(`[meta-webhook] Saved ${analysis.photo_type} photo to gallery: ${entitySlug}`)
  }

  // 2. Write hours exception if hours changed
  if (analysis.hours_change && analysis.hours) {
    const h = analysis.hours
    const date = h.date || new Date().toISOString().split('T')[0]
    await db.from('hours_exceptions').upsert({
      entity_slug: entitySlug,
      date,
      closed:      h.closed || false,
      open_time:   h.open_time || null,
      close_time:  h.close_time || null,
      note:        h.note || 'Updated via social media post',
      created_at:  new Date().toISOString(),
    }, { onConflict: 'entity_slug,date' })
    console.log(`[meta-webhook] Hours exception written for ${entitySlug} on ${date}: ${h.note}`)
  }
}


// Fires when you (or a connected business) posts a photo, video, or Reel.
async function handleInstagram(entry) {
  const changes = entry.changes || []
  for (const change of changes) {
    if (change.field !== 'media') continue
    const val = change.value || {}

    // val.media_id = the IG media ID
    // val.media_type = IMAGE | VIDEO | CAROUSEL_ALBUM
    // val.timestamp = unix epoch
    // We need to fetch the actual media URL — Meta webhooks give us the ID,
    // not the URL. The URL fetch uses a Page/User access token.
    // For now: store the media_id so we can fetch details on demand.
    const mediaId   = val.media_id || val.id
    const mediaType = (val.media_type || 'IMAGE').toLowerCase()
    const igUserId  = entry.id // the IG user/page ID

    if (!mediaId) continue

    // Look up which entity_slug this IG account belongs to
    const { data: match } = await db
      .from('entity')
      .select('slug, name')
      .eq('instagram_id', igUserId)
      .maybeSingle()

    const entitySlug = match?.slug || null

    // Fetch the media details from Meta Graph API if we have a token
    let imageUrl = null, videoUrl = null, caption = null, permalink = null
    const accessToken = process.env.META_PAGE_ACCESS_TOKEN
    if (accessToken && mediaId) {
      try {
        const fields = 'media_url,thumbnail_url,caption,permalink,timestamp,media_type'
        const r = await fetch(`https://graph.facebook.com/v18.0/${mediaId}?fields=${fields}&access_token=${accessToken}`)
        if (r.ok) {
          const d = await r.json()
          imageUrl  = d.thumbnail_url || d.media_url || null
          videoUrl  = mediaType === 'video' || mediaType === 'reel' ? d.media_url : null
          caption   = d.caption || null
          permalink = d.permalink || null
        }
      } catch {}
    }

    const isReel = mediaType === 'video' || String(val.media_type).toUpperCase() === 'VIDEO'

    await db.from('social_posts').upsert({
      entity_slug:     entitySlug,
      source:          'instagram',
      post_url:        permalink || `https://www.instagram.com/p/${mediaId}/`,
      image_url:       imageUrl,
      video_url:       videoUrl || null,
      caption:         caption,
      media_type:      isReel ? 'reel' : 'image',
      platform_post_id: mediaId,
      post_date:       val.timestamp ? new Date(val.timestamp * 1000).toISOString() : new Date().toISOString(),
      is_active:       true,
      show_on_home:    true,
      show_on_profile: !!entitySlug,
      created_at:      new Date().toISOString(),
    }, { onConflict: 'platform_post_id' })

    console.log(`[meta-webhook] IG post saved: ${mediaId} → entity: ${entitySlug || 'GCR own'}`)

    // Analyze caption + image — save to gallery, update hours if needed
    if (entitySlug) {
      const analysis = await analyzePost({ caption, imageUrl, entitySlug })
      await applyAnalysis(analysis, { entitySlug, imageUrl, postUrl: permalink })
    }
  }
}

// ── Facebook Page post event ──────────────────────────────────────────────────
// Fires when a connected Facebook Page publishes a post.
async function handleFacebook(entry) {
  const changes = entry.changes || []
  for (const change of changes) {
    if (change.field !== 'feed') continue
    const val = change.value || {}
    if (val.item !== 'post' || val.verb !== 'add') continue

    const postId    = val.post_id
    const pageId    = entry.id

    if (!postId) continue

    // Look up entity by facebook_page_id
    const { data: match } = await db
      .from('entity')
      .select('slug, name')
      .eq('facebook_page_id', pageId)
      .maybeSingle()

    const entitySlug = match?.slug || null

    // Fetch post details from Graph API
    let imageUrl = null, caption = null, permalink = null
    const accessToken = process.env.META_PAGE_ACCESS_TOKEN
    if (accessToken) {
      try {
        const fields = 'message,full_picture,permalink_url,created_time'
        const r = await fetch(`https://graph.facebook.com/v18.0/${postId}?fields=${fields}&access_token=${accessToken}`)
        if (r.ok) {
          const d = await r.json()
          imageUrl  = d.full_picture || null
          caption   = d.message || null
          permalink = d.permalink_url || null
        }
      } catch {}
    }

    await db.from('social_posts').upsert({
      entity_slug:     entitySlug,
      source:          'facebook',
      post_url:        permalink || `https://www.facebook.com/${postId}`,
      image_url:       imageUrl,
      caption:         caption,
      media_type:      imageUrl ? 'image' : 'text',
      platform_post_id: postId,
      post_date:       val.created_time || new Date().toISOString(),
      is_active:       true,
      show_on_home:    true,
      show_on_profile: !!entitySlug,
      created_at:      new Date().toISOString(),
    }, { onConflict: 'platform_post_id' })

    console.log(`[meta-webhook] FB post saved: ${postId} → entity: ${entitySlug || 'GCR own'}`)

    // Analyze caption + image — save to gallery, update hours if needed
    if (entitySlug) {
      const analysis = await analyzePost({ caption, imageUrl, entitySlug })
      await applyAnalysis(analysis, { entitySlug, imageUrl, postUrl: permalink })
    }
  }
}

module.exports = router
