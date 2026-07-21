/**
 * Universal AI Provider
 * ─────────────────────
 * One function call, any AI provider, configurable from the admin dashboard.
 * 
 * Usage:
 *   const { callAI, getProviderConfig } = require('./ai-provider')
 *   const result = await callAI('post_analysis', prompt)
 * 
 * Supported providers (add API key to Vercel env):
 *   anthropic  → ANTHROPIC_API_KEY
 *   openai     → OPENAI_API_KEY
 *   google     → GOOGLE_AI_API_KEY
 *   groq       → GROQ_API_KEY
 *   mistral    → MISTRAL_API_KEY
 *   ollama     → OLLAMA_BASE_URL (self-hosted, no key needed)
 */

const { createClient } = require('@supabase/supabase-js')

const db = createClient(
  process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
)

// Cache config for 60 seconds so we don't hit the DB on every call
let _configCache = {}
let _cacheTime = 0

async function getProviderConfig(task) {
  const now = Date.now()
  if (now - _cacheTime < 60000 && _configCache[task]) return _configCache[task]

  const { data } = await db
    .from('ai_provider_config')
    .select('provider, model')
    .eq('task', task)
    .eq('is_active', true)
    .maybeSingle()

  if (data) {
    _configCache[task] = data
    _cacheTime = now
  }

  return data || { provider: 'anthropic', model: 'claude-sonnet-4-6' } // safe default
}

// Invalidate cache when admin updates config
function invalidateCache() {
  _configCache = {}
  _cacheTime = 0
}

/**
 * Call whichever AI is configured for this task.
 * @param {string} task        - task key from ai_provider_config
 * @param {string} prompt      - the full prompt to send
 * @param {object} options     - { maxTokens, systemPrompt, imageUrl }
 * @returns {string}           - the text response from the AI
 */
async function callAI(task, prompt, options = {}) {
  const config = await getProviderConfig(task)
  const { provider, model } = config
  const maxTokens   = options.maxTokens   || 1024
  const systemPrompt = options.systemPrompt || 'You are a helpful assistant. Respond concisely and accurately.'

  console.log(`[ai-provider] task=${task} provider=${provider} model=${model}`)

  switch (provider) {
    case 'anthropic': return callAnthropic(model, prompt, systemPrompt, maxTokens, options.imageUrl)
    case 'openai':    return callOpenAI(model, prompt, systemPrompt, maxTokens, options.imageUrl)
    case 'google':    return callGoogle(model, prompt, systemPrompt, maxTokens, options.imageUrl)
    case 'groq':      return callGroq(model, prompt, systemPrompt, maxTokens)
    case 'mistral':   return callMistral(model, prompt, systemPrompt, maxTokens)
    case 'ollama':    return callOllama(model, prompt, systemPrompt, maxTokens)
    default:
      console.warn(`[ai-provider] Unknown provider: ${provider}, falling back to Anthropic`)
      return callAnthropic('claude-sonnet-4-6', prompt, systemPrompt, maxTokens, options.imageUrl)
  }
}

// ── Anthropic (Claude) ────────────────────────────────────────────────────────
async function callAnthropic(model, prompt, systemPrompt, maxTokens, imageUrl) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set')

  const content = imageUrl
    ? [{ type: 'image', source: { type: 'url', url: imageUrl } }, { type: 'text', text: prompt }]
    : prompt

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content }] })
  })
  if (!res.ok) throw new Error(`Anthropic error: ${res.status}`)
  const d = await res.json()
  return d.content?.[0]?.text || ''
}

// ── OpenAI (GPT-4o, GPT-4, etc.) ─────────────────────────────────────────────
async function callOpenAI(model, prompt, systemPrompt, maxTokens, imageUrl) {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set')

  const userContent = imageUrl
    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }]
    : prompt

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }]
    })
  })
  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`)
  const d = await res.json()
  return d.choices?.[0]?.message?.content || ''
}

// ── Google (Gemini) ───────────────────────────────────────────────────────────
async function callGoogle(model, prompt, systemPrompt, maxTokens, imageUrl) {
  const key = process.env.GOOGLE_AI_API_KEY
  if (!key) throw new Error('GOOGLE_AI_API_KEY not set')

  const parts = imageUrl
    ? [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: await urlToBase64(imageUrl) } }]
    : [{ text: prompt }]

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: maxTokens }
    })
  })
  if (!res.ok) throw new Error(`Google AI error: ${res.status}`)
  const d = await res.json()
  return d.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

// ── Groq (Llama, Mixtral, etc. — very fast) ──────────────────────────────────
async function callGroq(model, prompt, systemPrompt, maxTokens) {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new Error('GROQ_API_KEY not set')

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    })
  })
  if (!res.ok) throw new Error(`Groq error: ${res.status}`)
  const d = await res.json()
  return d.choices?.[0]?.message?.content || ''
}

// ── Mistral ───────────────────────────────────────────────────────────────────
async function callMistral(model, prompt, systemPrompt, maxTokens) {
  const key = process.env.MISTRAL_API_KEY
  if (!key) throw new Error('MISTRAL_API_KEY not set')

  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    })
  })
  if (!res.ok) throw new Error(`Mistral error: ${res.status}`)
  const d = await res.json()
  return d.choices?.[0]?.message?.content || ''
}

// ── Ollama (self-hosted) ──────────────────────────────────────────────────────
async function callOllama(model, prompt, systemPrompt, maxTokens) {
  const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    })
  })
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`)
  const d = await res.json()
  return d.message?.content || ''
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function urlToBase64(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    const buf = await res.arrayBuffer()
    return Buffer.from(buf).toString('base64')
  } catch {
    return ''
  }
}

// Available providers for the admin dropdown
const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)',    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'] },
  { value: 'openai',    label: 'OpenAI (GPT)',          models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
  { value: 'google',    label: 'Google (Gemini)',        models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'] },
  { value: 'groq',      label: 'Groq (Fast Inference)', models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'llama3-8b-8192'] },
  { value: 'mistral',   label: 'Mistral',               models: ['mistral-large-latest', 'mistral-small-latest', 'open-mixtral-8x22b'] },
  { value: 'ollama',    label: 'Ollama (Self-hosted)',  models: ['llama3', 'mistral', 'phi3', 'gemma2'] },
]

module.exports = { callAI, getProviderConfig, invalidateCache, PROVIDERS }
