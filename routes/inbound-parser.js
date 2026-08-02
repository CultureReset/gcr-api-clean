/**
 * STANDALONE INBOUND EMAIL PARSER
 * ===============================
 * Self-contained. Does not touch routes/email-parser.js (bookings),
 * routes/email-webhook.js (song requests), or utils/sms.js (Twilio).
 * Sends only via Sendblue.
 *
 * The flow, end to end:
 *   email arrives  →  first matching rule wins  →  extract fields via your
 *   regexes  →  POST the webhook  →  send the text
 *
 * You define the rules. A rule says:
 *   - which emails it matches   (match_from / match_subject / match_to)
 *   - what to pull out of them  (extract: { field: "regex with (capture)" })
 *   - where to POST             (webhook_url)
 *   - what text to send, to who (sms_template + sms_to[])
 *
 * ENDPOINTS
 *   POST   /api/inbound/email          ← point your email provider here
 *   GET    /api/inbound/rules          list rules
 *   POST   /api/inbound/rules          create a rule
 *   PUT    /api/inbound/rules/:id      update a rule
 *   DELETE /api/inbound/rules/:id      delete a rule
 *   POST   /api/inbound/rules/:id/test dry-run a rule against sample text
 *   GET    /api/inbound/log            what came in and what fired
 */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db');
const sendblue = require('../utils/sendblue');
const { adminRequired } = require('../middleware/auth');

// ─── MATCHING ────────────────────────────────────────────────────────────────

// Every match field is treated as a case-insensitive regex. A plain string like
// "billing@acme.com" works fine as one (the dots match themselves loosely, which
// is harmless here). Empty/null means "don't care".
function fieldMatches(pattern, value) {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'i').test(value || '');
  } catch {
    // Invalid regex in a rule — fall back to substring so a typo degrades
    // instead of throwing on every inbound email.
    return (value || '').toLowerCase().includes(String(pattern).toLowerCase());
  }
}

function ruleMatches(rule, email) {
  return fieldMatches(rule.match_from, email.from)
      && fieldMatches(rule.match_to, email.to)
      && fieldMatches(rule.match_subject, email.subject)
      && fieldMatches(rule.match_body, email.text);
}

// ─── EXTRACTION ──────────────────────────────────────────────────────────────

/**
 * rule.extract is a plain object: { field_name: "regex with one (capture group)" }
 * e.g. { song: "Song:\\s*(.+)", name: "From:\\s*(.+)", amount: "\\$([0-9.]+)" }
 *
 * Each regex runs against subject + body. Capture group 1 is the value; if the
 * regex has no capture group, the whole match is used.
 */
function extractFields(rule, email) {
  const out = {};
  const haystack = [email.subject || '', email.text || ''].join('\n');
  const spec = rule.extract && typeof rule.extract === 'object' ? rule.extract : {};

  for (const [field, pattern] of Object.entries(spec)) {
    if (!pattern) { out[field] = null; continue; }
    try {
      const m = haystack.match(new RegExp(pattern, 'i'));
      out[field] = m ? (m[1] !== undefined ? m[1].trim() : m[0].trim()) : null;
    } catch {
      out[field] = null;
    }
  }
  return out;
}

// {{token}} substitution. Tokens are extracted field names plus the built-ins
// from, to, subject, body. An unmatched token renders empty, not literally.
function fillTemplate(template, vars) {
  if (!template) return '';
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''
  );
}

// ─── ACTIONS ─────────────────────────────────────────────────────────────────

async function fireWebhook(rule, payload) {
  if (!rule.webhook_url) return null;

  const bodyStr = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (rule.webhook_secret) {
    headers['x-gcr-signature'] = crypto
      .createHmac('sha256', rule.webhook_secret)
      .update(bodyStr)
      .digest('hex');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(rule.webhook_url, {
      method: 'POST', headers, body: bodyStr, signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (String(phone).startsWith('+') && digits.length > 10) return String(phone);
  return null;
}

async function sendTexts(rule, message) {
  const numbers = (rule.sms_to || []).map(normalizePhone).filter(Boolean);
  if (!numbers.length || !message) return { sent: 0, failed: 0, results: [] };

  const results = [];
  let sent = 0, failed = 0;

  for (const number of numbers) {
    try {
      const data = await sendblue.sendMessage(number, message);
      results.push({ number, ok: true, handle: data.message_handle || null });
      sent++;
    } catch (err) {
      results.push({ number, ok: false, error: err.message });
      failed++;
    }
  }
  return { sent, failed, results };
}

// ─── INBOUND ─────────────────────────────────────────────────────────────────

/**
 * POST /api/inbound/email
 * Accepts SendGrid Inbound Parse / Postmark / Mailgun style bodies
 * (urlencoded or JSON): from, to, subject, text, html
 *
 * Protect it by setting INBOUND_PARSER_SECRET and having your provider send
 * ?secret=... or an x-webhook-secret header.
 */
router.post('/email',
  express.urlencoded({ extended: false, limit: '10mb' }),
  express.json({ limit: '10mb' }),
  async (req, res) => {

  const configured = process.env.INBOUND_PARSER_SECRET;
  if (configured) {
    const supplied = req.headers['x-webhook-secret'] || req.query.secret;
    if (supplied !== configured) return res.status(401).json({ error: 'Unauthorized' });
  }

  const email = {
    from:    req.body.from    || req.body.From    || req.body.sender    || '',
    to:      req.body.to      || req.body.To      || req.body.recipient || '',
    subject: req.body.subject || req.body.Subject || '',
    text:    req.body.text    || req.body.Text    || req.body['body-plain'] || '',
    html:    req.body.html    || req.body.Html    || '',
  };

  // Answer the provider immediately — parsing and sending happen after.
  res.status(200).json({ received: true });

  try {
    if (!email.text && email.html) {
      email.text = email.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    const { data: rules } = await db
      .from('inbound_rules')
      .select('*')
      .eq('is_active', true)
      .order('priority', { ascending: false });

    const rule = (rules || []).find(r => ruleMatches(r, email));

    if (!rule) {
      await db.from('inbound_parser_log').insert({
        from_email: email.from, to_email: email.to, subject: email.subject,
        raw_text: (email.text || '').slice(0, 5000),
        status: 'no_rule_matched',
        created_at: new Date().toISOString(),
      }).catch(() => {});
      return;
    }

    const fields = extractFields(rule, email);
    const vars = {
      ...fields,
      from: email.from, to: email.to, subject: email.subject, body: email.text,
    };

    const message = fillTemplate(rule.sms_template, vars);
    const payload = {
      rule: rule.name,
      rule_id: rule.id,
      received_at: new Date().toISOString(),
      fields,
      email: { from: email.from, to: email.to, subject: email.subject },
    };

    // Webhook first, then the text — the user's stated order: process, then send.
    const hookResult = await fireWebhook(rule, payload);
    const smsResult  = await sendTexts(rule, message);

    await db.from('inbound_parser_log').insert({
      rule_id: rule.id,
      rule_name: rule.name,
      from_email: email.from, to_email: email.to, subject: email.subject,
      raw_text: (email.text || '').slice(0, 5000),
      extracted: fields,
      sms_message: message || null,
      sms_sent: smsResult.sent,
      sms_failed: smsResult.failed,
      sms_results: smsResult.results,
      webhook_url: rule.webhook_url || null,
      webhook_status: hookResult ? (hookResult.ok ? 'ok' : (hookResult.error || `HTTP ${hookResult.status}`)) : null,
      status: 'processed',
      created_at: new Date().toISOString(),
    }).catch(() => {});

  } catch (err) {
    console.error('[inbound-parser] error:', err.message);
  }
});

// ─── RULE MANAGEMENT ─────────────────────────────────────────────────────────

const RULE_FIELDS = [
  'name', 'match_from', 'match_to', 'match_subject', 'match_body',
  'extract', 'webhook_url', 'webhook_secret', 'sms_to', 'sms_template',
  'priority', 'is_active',
];

router.get('/rules', adminRequired, async (req, res) => {
  const { data, error } = await db
    .from('inbound_rules')
    .select('id, name, match_from, match_to, match_subject, match_body, extract, webhook_url, sms_to, sms_template, priority, is_active, created_at')
    .order('priority', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ rules: data || [] });
});

router.post('/rules', adminRequired, async (req, res) => {
  const { name, sms_to } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  if (!req.body.match_from && !req.body.match_subject && !req.body.match_to && !req.body.match_body) {
    return res.status(400).json({ error: 'at least one match_* field required, or the rule catches every email' });
  }
  if (sms_to !== undefined && !Array.isArray(sms_to)) {
    return res.status(400).json({ error: 'sms_to must be an array of phone numbers' });
  }

  const row = { created_at: new Date().toISOString() };
  for (const f of RULE_FIELDS) if (req.body[f] !== undefined) row[f] = req.body[f];

  const { data, error } = await db.from('inbound_rules').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, rule: data });
});

router.put('/rules/:id', adminRequired, async (req, res) => {
  if (req.body.sms_to !== undefined && !Array.isArray(req.body.sms_to)) {
    return res.status(400).json({ error: 'sms_to must be an array of phone numbers' });
  }

  const patch = { updated_at: new Date().toISOString() };
  for (const f of RULE_FIELDS) if (req.body[f] !== undefined) patch[f] = req.body[f];

  const { data, error } = await db
    .from('inbound_rules').update(patch).eq('id', req.params.id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'Rule not found' });
  res.json({ success: true, rule: data });
});

router.delete('/rules/:id', adminRequired, async (req, res) => {
  const { error } = await db.from('inbound_rules').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/**
 * POST /api/inbound/rules/:id/test
 * Body: { from, to, subject, text, send? }
 * Dry-runs the rule: shows what it matches, what it extracts, and the exact
 * text it would send. Nothing is sent unless send:true.
 */
router.post('/rules/:id/test', adminRequired, async (req, res) => {
  const { data: rule } = await db.from('inbound_rules').select('*').eq('id', req.params.id).maybeSingle();
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  const email = {
    from: req.body.from || '', to: req.body.to || '',
    subject: req.body.subject || '', text: req.body.text || '',
  };

  const matched = ruleMatches(rule, email);
  const fields  = extractFields(rule, email);
  const message = fillTemplate(rule.sms_template, {
    ...fields, from: email.from, to: email.to, subject: email.subject, body: email.text,
  });

  let sent = null;
  if (req.body.send === true && matched) {
    sent = await sendTexts(rule, message);
  }

  res.json({
    matched,
    extracted: fields,
    would_send_to: rule.sms_to || [],
    would_send_text: message,
    would_post_to: rule.webhook_url || null,
    sent,
  });
});

// ─── LOG ─────────────────────────────────────────────────────────────────────

router.get('/log', adminRequired, async (req, res) => {
  const { rule_id, status, limit = 100, offset = 0 } = req.query;

  let q = db.from('inbound_parser_log').select('*')
    .order('created_at', { ascending: false })
    .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

  if (rule_id) q = q.eq('rule_id', rule_id);
  if (status)  q = q.eq('status', status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ log: data || [] });
});

// GET /api/inbound/status — is Sendblue actually configured?
router.get('/status', async (req, res) => {
  res.json({
    sendblue_configured: await sendblue.isConfigured(),
    inbound_secret_set: !!process.env.INBOUND_PARSER_SECRET,
  });
});

module.exports = router;
