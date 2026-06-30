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

const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
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

// ── Instagram media event ─────────────────────────────────────────────────────
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
  }
}

module.exports = router
