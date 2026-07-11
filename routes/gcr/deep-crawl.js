const express = require('express')
const router = express.Router()
const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')
const { findExistingEntity, possibleFuzzyDuplicate } = require('../../lib/find-existing-entity')

const db = createClient(
  process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Fetch a URL, return cleaned text (strip scripts/styles/nav) */
async function fetchPageText(url, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GulfCoastRadar/1.0; +https://gulfcoastradar.com)',
        'Accept': 'text/html,application/xhtml+xml',
      }
    })
    clearTimeout(timer)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const html = await resp.text()
    // Strip scripts, styles, nav, footer, head
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return clean.slice(0, 12000) // cap at ~3k tokens of context
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

/** Slugify a business name */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** Map categories_seen to entity_type and entity_subtype */
function mapProfileType(recommendedType, categoriesSeen) {
  const cats = (categoriesSeen || '').toLowerCase()
  if (recommendedType === 'restaurant') {
    if (cats.includes('nightlife') || cats.includes('bar')) return { entity_type: 'restaurant', entity_subtype: 'bar' }
    if (cats.includes('coffee') || cats.includes('donut') || cats.includes('dessert')) return { entity_type: 'coffee', entity_subtype: 'coffee_shop' }
    return { entity_type: 'restaurant', entity_subtype: 'restaurant' }
  }
  if (recommendedType === 'water_activity_or_charter') {
    if (cats.includes('fishing_charter_or_guide')) return { entity_type: 'activity', entity_subtype: 'fishing_charter' }
    if (cats.includes('marina')) return { entity_type: 'activity', entity_subtype: 'marina' }
    if (cats.includes('cruise') || cats.includes('dolphin')) return { entity_type: 'activity', entity_subtype: 'tour_agency' }
    if (cats.includes('jet_ski') || cats.includes('boat_rental') || cats.includes('kayak') || cats.includes('paddle')) return { entity_type: 'activity', entity_subtype: 'watersports' }
    if (cats.includes('parasail')) return { entity_type: 'activity', entity_subtype: 'parasailing' }
    if (cats.includes('dive')) return { entity_type: 'activity', entity_subtype: 'dive_shop' }
    return { entity_type: 'activity', entity_subtype: 'tour_agency' }
  }
  if (recommendedType === 'attraction_or_activity') {
    if (cats.includes('golf')) return { entity_type: 'activity', entity_subtype: 'golf_course' }
    if (cats.includes('museum') || cats.includes('arts') || cats.includes('history')) return { entity_type: 'activity', entity_subtype: 'museum' }
    if (cats.includes('nightlife') || cats.includes('bar')) return { entity_type: 'restaurant', entity_subtype: 'bar' }
    if (cats.includes('park') || cats.includes('nature') || cats.includes('trail')) return { entity_type: 'park', entity_subtype: 'park' }
    if (cats.includes('shopping')) return { entity_type: 'shopping', entity_subtype: 'specialty_store' }
    return { entity_type: 'activity', entity_subtype: 'attraction' }
  }
  return { entity_type: 'service', entity_subtype: 'service' }
}

/** Call Claude to extract structured business data from page text */
async function extractWithClaude(job, pageText) {
  const systemPrompt = `You are a Gulf Coast Alabama business data extractor for Gulf Coast Radar (GCR), a local discovery platform serving tourists in Gulf Shores and Orange Beach, Alabama.

Extract structured business information from the provided webpage text. Return ONLY valid JSON. No preamble, no markdown, no explanation.

The JSON must match exactly this schema:
{
  "name": "Official business name",
  "phone": "Phone number or null",
  "email": "Email or null",
  "address_line_1": "Street address or null",
  "city": "City name or null",
  "state": "AL or null",
  "zip": "ZIP code or null",
  "website_url": "Official URL or null",
  "booking_url": "Booking/reservation URL or null",
  "hours_text": "Hours summary as text or null",
  "price_summary": "Price range or starting prices as text or null",
  "description": "2-3 sentence customer-facing description or null",
  "ai_overview": "Concise 1-paragraph tourist-facing overview highlighting what makes this place worth visiting or null",
  "known_for": "What this business is best known for, 1 sentence or null",
  "good_for": "Who this is best for (families, couples, anglers, etc.) or null",
  "social_instagram": "Instagram URL or handle or null",
  "social_facebook": "Facebook URL or null",
  "reservation_url": "Reservation URL if separate from booking_url or null",
  "menu_url": "Menu URL if restaurant or null",
  "price_from": null or numeric starting price as a number,
  "price_unit": "per person, per hour, per trip, etc. or null",
  "capacity_max": null or maximum capacity as a number,
  "outdoor_seating": true or false or null,
  "live_music": true or false or null,
  "pet_friendly": true or false or null,
  "good_for_kids": true or false or null,
  "serves_alcohol": true or false or null,
  "parking": true or false or null,
  "wheelchair_accessible_entrance": true or false or null,
  "services": ["list", "of", "key", "services", "or", "products"],
  "fish_species": ["only if fishing charter - list of target species"],
  "trip_types": ["only if charter/tour - types of trips offered"],
  "what_to_bring": ["only if charter/activity - what guests should bring"],
  "whats_included": ["only if charter/activity - what is included in the price"],
  "confidence": "high, medium, or low based on how much real data you found"
}`

  const userMsg = `Business: ${job.business_name}
Area: ${job.area}
Type: ${job.recommended_profile_type}
Category hints: ${job.categories_seen}
Known about them: ${job.description_snippet}

Webpage content:
${pageText}`

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1500,
    temperature: 0.1,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMsg }],
  })

  const text = response.content?.find(b => b.type === 'text')?.text || '{}'
  const tokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)

  // Parse JSON
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const data = JSON.parse(cleaned)
  return { data, tokens, model: response.model }
}

/** Write extracted data to entity table (upsert) or create new entity */
async function writeToEntity(job, extracted) {
  const { entity_type, entity_subtype } = mapProfileType(
    job.recommended_profile_type,
    job.categories_seen
  )

  // Check if this business already exists. Exact name match first (cheapest,
  // catches literal re-runs of the same job), then phone number — the name
  // string varies by source ("The Hangout" vs "The Hangout Gulf Shores"), so
  // an exact-name-only check silently created a duplicate row per source.
  const { data: existing } = await db
    .from('entity')
    .select('slug, id')
    .ilike('name', job.business_name.trim())
    .limit(1)
    .maybeSingle()

  const phoneMatch = !existing ? await findExistingEntity(db, { phone: extracted.phone }) : null
  const matchedSlug = existing?.slug || phoneMatch?.slug

  if (!matchedSlug) {
    const fuzzy = await possibleFuzzyDuplicate(db, job.business_name)
    if (fuzzy) {
      console.warn(`[deep-crawl] "${job.business_name}" has no phone/name match but is ${Math.round(fuzzy.similarity * 100)}% similar to existing "${fuzzy.slug}" — creating a new row anyway; review manually if this is really the same business.`)
    }
  }

  const slug = matchedSlug || slugify(job.business_name)

  const payload = {
    slug,
    name: extracted.name || job.business_name,
    entity_type,
    entity_subtype,
    is_active: true,
    city: extracted.city || job.area || null,
    state: extracted.state || 'AL',
    phone: extracted.phone || null,
    email: extracted.email || null,
    address_line_1: extracted.address_line_1 || null,
    zip: extracted.zip || null,
    website_url: extracted.website_url || job.website_url || null,
    booking_url: extracted.booking_url || null,
    reservation_url: extracted.reservation_url || null,
    menu_url: extracted.menu_url || null,
    social_instagram: extracted.social_instagram || null,
    social_facebook: extracted.social_facebook || null,
    description: extracted.description || job.description_snippet || null,
    ai_overview: extracted.ai_overview || null,
    known_for: extracted.known_for || null,
    good_for: extracted.good_for || null,
    price_from: extracted.price_from || null,
    price_unit: extracted.price_unit || null,
    capacity_max: extracted.capacity_max || null,
    outdoor_seating: extracted.outdoor_seating ?? null,
    live_music: extracted.live_music ?? null,
    pet_friendly: extracted.pet_friendly ?? null,
    good_for_kids: extracted.good_for_kids ?? null,
    serves_beer: extracted.serves_alcohol ?? null,
    parking: extracted.parking ?? null,
    wheelchair_accessible_entrance: extracted.wheelchair_accessible_entrance ?? null,
    updated_at: new Date().toISOString(),
  }

  const { data: upserted, error } = await db
    .from('entity')
    .upsert(payload, { onConflict: 'slug', ignoreDuplicates: false })
    .select('slug')
    .single()

  if (error) throw new Error(`Entity upsert failed: ${error.message}`)

  const entitySlug = upserted?.slug || slug

  // Write fish_species if present
  if (extracted.fish_species?.length) {
    const fishRows = extracted.fish_species.map((s, i) => ({
      entity_slug: entitySlug,
      species: s,
      sort_order: i,
    }))
    await db.from('fish_species').upsert(fishRows, { onConflict: 'entity_slug,species', ignoreDuplicates: true })
  }

  // Write what_to_bring if present
  if (extracted.what_to_bring?.length) {
    const wtbRows = extracted.what_to_bring.map((item, i) => ({
      entity_slug: entitySlug,
      item,
      sort_order: i,
    }))
    await db.from('what_to_bring').upsert(wtbRows, { onConflict: 'entity_slug,item', ignoreDuplicates: true })
  }

  // Write whats_included if present
  if (extracted.whats_included?.length) {
    const wiRows = extracted.whats_included.map((item_name, i) => ({
      entity_slug: entitySlug,
      item_name,
      sort_order: i,
    }))
    await db.from('whats_included').upsert(wiRows, { onConflict: 'entity_slug,item_name', ignoreDuplicates: true })
  }

  // Write services as entity_tags if present
  if (extracted.services?.length) {
    const tagRows = extracted.services.slice(0, 10).map(tag => ({
      entity_slug: entitySlug,
      tag_name: tag,
      tag_category: 'service',
    }))
    await db.from('entity_tags').upsert(tagRows, { onConflict: 'entity_slug,tag_name', ignoreDuplicates: true })
  }

  return entitySlug
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

/**
 * GET /api/gcr/deep-crawl/status
 * Queue status overview
 */
router.get('/status', async (req, res) => {
  try {
    const { data, error } = await db
      .from('deep_crawl_jobs')
      .select('status, deep_crawl_priority, recommended_profile_type')

    if (error) return res.status(500).json({ error: error.message })

    const counts = { total: data.length, by_status: {}, by_priority: {}, by_type: {} }
    data.forEach(r => {
      counts.by_status[r.status] = (counts.by_status[r.status] || 0) + 1
      counts.by_priority[r.deep_crawl_priority] = (counts.by_priority[r.deep_crawl_priority] || 0) + 1
      counts.by_type[r.recommended_profile_type] = (counts.by_type[r.recommended_profile_type] || 0) + 1
    })

    return res.json(counts)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/gcr/deep-crawl/jobs
 * List jobs with optional filter
 * ?status=pending&priority=High&limit=20
 */
router.get('/jobs', async (req, res) => {
  try {
    const { status = 'pending', priority, limit = 20, offset = 0 } = req.query
    let query = db
      .from('deep_crawl_jobs')
      .select('id, business_name, area, website_url, status, deep_crawl_priority, recommended_profile_type, entity_slug, attempts, error_message, completed_at')
      .order('deep_crawl_priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(parseInt(limit))
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)

    if (status) query = query.eq('status', status)
    if (priority) query = query.eq('deep_crawl_priority', priority)

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ jobs: data || [], count: data?.length })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/gcr/deep-crawl/run
 * Process N jobs from the queue. Called by cron or manual trigger.
 * Body: { limit: 5, priority: 'High', secret: '...' }
 *
 * Workflow per job:
 *  1. Mark as 'crawling'
 *  2. Fetch website HTML → extract text
 *  3. Mark as 'extracting', call Claude
 *  4. Mark as 'writing', upsert to entity + related tables
 *  5. Mark as 'done'
 */
router.post('/run', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.body?.secret
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const limit = Math.min(parseInt(req.body?.limit || 5), 20) // max 20 per run
  const priority = req.body?.priority || 'High'

  // Grab pending jobs
  const { data: jobs, error: fetchErr } = await db
    .from('deep_crawl_jobs')
    .select('*')
    .eq('status', 'pending')
    .eq('deep_crawl_priority', priority)
    .not('website_url', 'is', null)
    .lt('attempts', 3) // max 3 attempts per job
    .order('created_at', { ascending: true })
    .limit(limit)

  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!jobs?.length) return res.json({ message: 'No pending jobs', processed: 0 })

  const results = []

  for (const job of jobs) {
    const result = { id: job.id, business_name: job.business_name, status: null, error: null }

    try {
      // Mark as crawling
      await db.from('deep_crawl_jobs').update({
        status: 'crawling',
        attempts: (job.attempts || 0) + 1,
        last_attempted_at: new Date().toISOString(),
      }).eq('id', job.id)

      // Step 1: Fetch page
      let pageText
      try {
        pageText = await fetchPageText(job.website_url)
      } catch (fetchErr) {
        await db.from('deep_crawl_jobs').update({
          status: 'failed',
          error_message: `Fetch failed: ${fetchErr.message}`,
          updated_at: new Date().toISOString(),
        }).eq('id', job.id)
        result.status = 'failed'
        result.error = `Fetch: ${fetchErr.message}`
        results.push(result)
        continue
      }

      // Step 2: Extract with Claude
      await db.from('deep_crawl_jobs').update({ status: 'extracting' }).eq('id', job.id)

      let extracted, tokens, model
      try {
        ;({ data: extracted, tokens, model } = await extractWithClaude(job, pageText))
      } catch (aiErr) {
        await db.from('deep_crawl_jobs').update({
          status: 'failed',
          error_message: `AI extraction failed: ${aiErr.message}`,
          raw_html_length: pageText.length,
          updated_at: new Date().toISOString(),
        }).eq('id', job.id)
        result.status = 'failed'
        result.error = `AI: ${aiErr.message}`
        results.push(result)
        continue
      }

      // Step 3: Write to entity table
      await db.from('deep_crawl_jobs').update({ status: 'writing' }).eq('id', job.id)

      let entitySlug
      try {
        entitySlug = await writeToEntity(job, extracted)
      } catch (writeErr) {
        await db.from('deep_crawl_jobs').update({
          status: 'failed',
          error_message: `Write failed: ${writeErr.message}`,
          extracted_json: extracted,
          raw_html_length: pageText.length,
          updated_at: new Date().toISOString(),
        }).eq('id', job.id)
        result.status = 'failed'
        result.error = `Write: ${writeErr.message}`
        results.push(result)
        continue
      }

      // Step 4: Mark done
      const populated = Object.entries(extracted)
        .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
        .map(([k]) => k)

      await db.from('deep_crawl_jobs').update({
        status: 'done',
        entity_slug: entitySlug,
        raw_html_length: pageText.length,
        extracted_json: extracted,
        fields_populated: populated,
        ai_model_used: model,
        tokens_used: tokens,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_message: null,
      }).eq('id', job.id)

      result.status = 'done'
      result.entity_slug = entitySlug
      result.fields_populated = populated.length
      result.confidence = extracted.confidence

    } catch (err) {
      await db.from('deep_crawl_jobs').update({
        status: 'failed',
        error_message: err.message,
        updated_at: new Date().toISOString(),
      }).eq('id', job.id)
      result.status = 'failed'
      result.error = err.message
    }

    results.push(result)

    // Small delay between requests to be polite
    await new Promise(r => setTimeout(r, 1500))
  }

  const done = results.filter(r => r.status === 'done').length
  const failed = results.filter(r => r.status === 'failed').length

  return res.json({
    processed: results.length,
    done,
    failed,
    results,
    timestamp: new Date().toISOString(),
  })
})

/**
 * POST /api/gcr/deep-crawl/retry-failed
 * Reset failed jobs back to pending for retry
 */
router.post('/retry-failed', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.body?.secret
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { data, error } = await db
    .from('deep_crawl_jobs')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'failed')
    .lt('attempts', 3)
    .select('id')

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ reset: data?.length || 0 })
})

/**
 * GET /api/gcr/deep-crawl/results
 * View completed crawl results with extracted data
 */
router.get('/results', async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query
    const { data, error } = await db
      .from('deep_crawl_jobs')
      .select('business_name, area, entity_slug, fields_populated, tokens_used, completed_at, extracted_json')
      .eq('status', 'done')
      .order('completed_at', { ascending: false })
      .limit(parseInt(limit))
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)

    if (error) return res.status(500).json({ error: error.message })
    return res.json({ results: data || [] })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
