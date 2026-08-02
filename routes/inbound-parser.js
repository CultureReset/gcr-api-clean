/**
 * STANDALONE INBOUND EMAIL PARSER
 * ===============================
 * Self-contained. Does not touch routes/email-parser.js (bookings),
 * routes/email-webhook.js (song requests), or utils/sms.js (Twilio).
 * Sends only via Sendblue.
 *
 * The flow, end to end:
 *   email arrives  →  first matching rule wins  →  extract fields via your
 *   regexes  →  run whatever actions THAT rule declares
 *
 * Reading an email does not imply sending a text. A rule runs exactly the
 * actions listed in its `actions` array and nothing else — so one sender can
 * trigger a webhook only, another a text only, another both, another neither
 * (parse and log). Different sender, different rule, different behavior.
 *
 * You define the rules. A rule says:
 *   - which emails it matches   (match_from / match_subject / match_to)
 *   - what to pull out of them  (extract: { field: "regex with (capture)" })
 *   - what to do about it       (actions: [{type:'webhook'...},{type:'sms'...}])
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

async function fireWebhook(action, payload) {
  if (!action.url) return { ok: false, error: 'webhook action has no url' };

  const bodyStr = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (action.secret) {
    headers['x-gcr-signature'] = crypto
      .createHmac('sha256', action.secret)
      .update(bodyStr)
      .digest('hex');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(action.url, {
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

async function sendTexts(action, vars) {
  const numbers = (action.to || []).map(normalizePhone).filter(Boolean);
  const message = fillTemplate(action.template, vars);

  if (!numbers.length) return { sent: 0, failed: 0, message, results: [], skipped: 'no recipients' };
  if (!message)        return { sent: 0, failed: 0, message, results: [], skipped: 'template rendered empty' };

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
  return { sent, failed, message, results };
}

/**
 * Run exactly the actions a rule declares, in order. An empty/absent actions
 * array means the email is parsed and logged and nothing else happens — that is
 * a valid, useful configuration, not a misconfiguration.
 */
async function runActions(rule, vars, payload) {
  const actions = Array.isArray(rule.actions) ? rule.actions : [];
  const outcomes = [];

  for (const action of actions) {
    if (action.enabled === false) {
      outcomes.push({ type: action.type, status: 'disabled' });
      continue;
    }

    switch ((action.type || '').toLowerCase()) {
      case 'webhook': {
        const r = await fireWebhook(action, payload);
        outcomes.push({
          type: 'webhook',
          target: action.url,
          status: r.ok ? 'ok' : 'failed',
          error: r.ok ? null : (r.error || `HTTP ${r.status}`),
        });
        break;
      }
      case 'sms': {
        const r = await sendTexts(action, vars);
        outcomes.push({
          type: 'sms',
          target: action.to || [],
          status: r.skipped ? 'skipped' : (r.failed ? 'partial' : 'ok'),
          sent: r.sent,
          failed: r.failed,
          message: r.message,
          error: r.skipped || null,
          results: r.results,
        });
        break;
      }
      default:
        outcomes.push({ type: action.type || 'unknown', status: 'unsupported_action_type' });
    }
  }

  return outcomes;
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

    const payload = {
      rule: rule.name,
      rule_id: rule.id,
      received_at: new Date().toISOString(),
      fields,
      email: { from: email.from, to: email.to, subject: email.subject },
    };

    // Only what this rule declares. No actions → parsed and logged, nothing sent.
    const outcomes = await runActions(rule, vars, payload);

    await db.from('inbound_parser_log').insert({
      rule_id: rule.id,
      rule_name: rule.name,
      from_email: email.from, to_email: email.to, subject: email.subject,
      raw_text: (email.text || '').slice(0, 5000),
      extracted: fields,
      actions_run: outcomes,
      status: outcomes.length ? 'processed' : 'parsed_no_actions',
      created_at: new Date().toISOString(),
    }).catch(() => {});

  } catch (err) {
    console.error('[inbound-parser] error:', err.message);
  }
});

// ─── RULE MANAGEMENT ─────────────────────────────────────────────────────────

const RULE_FIELDS = [
  'name', 'match_from', 'match_to', 'match_subject', 'match_body',
  'extract', 'actions', 'priority', 'is_active',
];

const SUPPORTED_ACTIONS = ['webhook', 'sms'];

// Catch a malformed action at write time — otherwise it fails silently at 3am
// when the email actually arrives.
function validateActions(actions) {
  if (actions === undefined || actions === null) return { ok: true };
  if (!Array.isArray(actions)) return { error: 'actions must be an array' };

  for (const [i, a] of actions.entries()) {
    if (!a || typeof a !== 'object') return { error: `actions[${i}] must be an object` };
    const type = (a.type || '').toLowerCase();
    if (!SUPPORTED_ACTIONS.includes(type)) {
      return { error: `actions[${i}].type must be one of: ${SUPPORTED_ACTIONS.join(', ')}` };
    }
    if (type === 'webhook' && !a.url) {
      return { error: `actions[${i}] (webhook) requires a url` };
    }
    if (type === 'webhook' && !/^https?:\/\//i.test(a.url)) {
      return { error: `actions[${i}].url must be http(s)` };
    }
    if (type === 'sms') {
      if (!Array.isArray(a.to) || !a.to.length) {
        return { error: `actions[${i}] (sms) requires a non-empty "to" array` };
      }
      if (!a.template) {
        return { error: `actions[${i}] (sms) requires a "template"` };
      }
    }
  }
  return { ok: true };
}

router.get('/rules', adminRequired, async (req, res) => {
  const { data, error } = await db
    .from('inbound_rules')
    .select('id, name, match_from, match_to, match_subject, match_body, extract, actions, priority, is_active, created_at')
    .order('priority', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ rules: data || [] });
});

router.post('/rules', adminRequired, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  if (!req.body.match_from && !req.body.match_subject && !req.body.match_to && !req.body.match_body) {
    return res.status(400).json({ error: 'at least one match_* field required, or the rule catches every email' });
  }

  const check = validateActions(req.body.actions);
  if (check.error) return res.status(400).json({ error: check.error });

  const row = { created_at: new Date().toISOString() };
  for (const f of RULE_FIELDS) if (req.body[f] !== undefined) row[f] = req.body[f];

  const { data, error } = await db.from('inbound_rules').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, rule: data });
});

router.put('/rules/:id', adminRequired, async (req, res) => {
  const check = validateActions(req.body.actions);
  if (check.error) return res.status(400).json({ error: check.error });

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
  const vars = {
    ...fields, from: email.from, to: email.to, subject: email.subject, body: email.text,
  };

  // What WOULD run, rendered but not executed.
  const planned = (Array.isArray(rule.actions) ? rule.actions : []).map(a => {
    const type = (a.type || '').toLowerCase();
    if (type === 'sms') {
      return { type: 'sms', to: a.to || [], text: fillTemplate(a.template, vars), enabled: a.enabled !== false };
    }
    if (type === 'webhook') {
      return { type: 'webhook', url: a.url, signed: !!a.secret, enabled: a.enabled !== false };
    }
    return { type: a.type || 'unknown', enabled: a.enabled !== false };
  });

  let executed = null;
  if (req.body.send === true && matched) {
    executed = await runActions(rule, vars, {
      rule: rule.name, rule_id: rule.id, test: true,
      received_at: new Date().toISOString(), fields,
      email: { from: email.from, to: email.to, subject: email.subject },
    });
  }

  res.json({
    matched,
    extracted: fields,
    would_run: planned,
    note: planned.length ? undefined : 'This rule has no actions — it parses and logs only.',
    executed,
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
