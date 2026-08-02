/**
 * SENDBLUE CLIENT
 * ===============
 * iMessage/SMS/RCS delivery for GCR notifications.
 *
 * Config resolution order:
 *   1. SENDBLUE_KEY_ID / SENDBLUE_SECRET env vars (set these in Vercel)
 *   2. platform_settings row with key = 'sms_config'  (optional, fail-soft —
 *      the table may not exist in the GCR Supabase, in which case env wins)
 *
 * Sendblue auth is two headers, not a bearer token:
 *   sb-api-key-id / sb-api-secret-key
 */

const db = require('../db');

const SENDBLUE_BASE = process.env.SENDBLUE_API_BASE || 'https://api.sendblue.co';

// Cache the platform_settings lookup — it's the same row on every send and the
// table may not exist at all. Re-checked every 60s so a key rotation lands
// without a redeploy.
let _cached = null;
let _cachedAt = 0;
const CACHE_MS = 60 * 1000;

async function getSendblueConfig() {
  const envCfg = {
    key_id: process.env.SENDBLUE_KEY_ID || null,
    secret: process.env.SENDBLUE_SECRET || null,
    from_number: process.env.SENDBLUE_FROM_NUMBER || null,
  };

  // Env alone is enough — don't pay for a DB round trip if it's fully set.
  if (envCfg.key_id && envCfg.secret) return envCfg;

  if (_cached && Date.now() - _cachedAt < CACHE_MS) return _cached;

  let dbCfg = {};
  try {
    const { data } = await db
      .from('platform_settings')
      .select('value')
      .eq('key', 'sms_config')
      .maybeSingle();
    dbCfg = data?.value || {};
  } catch {
    // table missing / no access — env-only mode
  }

  _cached = {
    key_id: envCfg.key_id || dbCfg.sendblue_key_id || null,
    secret: envCfg.secret || dbCfg.sendblue_secret || null,
    from_number: envCfg.from_number || dbCfg.sendblue_from_number || null,
  };
  _cachedAt = Date.now();
  return _cached;
}

async function isConfigured() {
  const cfg = await getSendblueConfig();
  return !!(cfg.key_id && cfg.secret);
}

async function sendblueRequest(path, body) {
  const cfg = await getSendblueConfig();
  if (!cfg.key_id || !cfg.secret) {
    const err = new Error('Sendblue not configured');
    err.code = 'not_configured';
    throw err;
  }

  const res = await fetch(SENDBLUE_BASE + path, {
    method: 'POST',
    headers: {
      'sb-api-key-id': cfg.key_id,
      'sb-api-secret-key': cfg.secret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cfg.from_number ? { ...body, from_number: cfg.from_number } : body),
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(data.message || data.error || `Sendblue HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/** Send to one number. `number` must be E.164 (+15551234567). */
function sendMessage(number, content) {
  return sendblueRequest('/api/send-message', { number, content });
}

/** Send one group thread to many numbers (single iMessage group, not N sends). */
function sendGroupMessage(numbers, content) {
  return sendblueRequest('/api/send-group-message', { numbers, content });
}

module.exports = {
  getSendblueConfig,
  isConfigured,
  sendMessage,
  sendGroupMessage,
  SENDBLUE_BASE,
};
