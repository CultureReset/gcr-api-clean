// ============================================================
// EMAIL TEMPLATES — platform emails as files, sent through utils/email.js
// ============================================================
//
// Each template is templates/email/<name>.json: { subject, html, required? }.
// {{key}} is filled from the data (HTML-escaped; a key ending in _link must be
// an http(s) URL), and {{brand}} from PLATFORM_NAME. A new email is a new
// file, not code. Used by POST /api/nextgent/email (signed).

const fs = require('fs');
const path = require('path');
const { envStr } = require('./env');

const DIR = path.join(__dirname, '..', 'templates', 'email');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const httpError = (status, message) => Object.assign(new Error(message), { status });

function load(name) {
    if (!NAME_RE.test(String(name || ''))) throw httpError(400, 'Not a template name.');
    const file = path.join(DIR, `${name}.json`);
    if (!fs.existsSync(file)) throw httpError(404, `No email template ${name}.`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function render(name, data = {}) {
    const t = load(name);
    const brand = envStr('PLATFORM_NAME');
    if (!brand) throw httpError(503, 'PLATFORM_NAME is not set.');
    const values = { ...(data && typeof data === 'object' ? data : {}), brand };
    for (const key of t.required || []) {
        if (values[key] === undefined || values[key] === null || String(values[key]).trim() === '') throw httpError(400, `data.${key} is required.`);
    }
    for (const [k, v] of Object.entries(values)) {
        if (/_link$/.test(k) && !/^https?:\/\//i.test(String(v))) throw httpError(400, `data.${k} must be an http(s) link.`);
    }
    const fill = (s, escape) => String(s || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => (escape ? esc(values[k]) : String(values[k] ?? '').replace(/[\r\n]+/g, ' ')));
    return { subject: fill(t.subject, false).slice(0, 300), html: fill(t.html, true) };
}

/** Render and send. Resolves { sent, reason? }. */
async function sendTemplate({ to, template, data }) {
    const addr = String(to || '').trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr)) throw httpError(400, 'to must be an email address.');
    const { subject, html } = render(template, data);
    const { sendEmail } = require('../utils/email');
    const r = await sendEmail({ to: addr, subject, html });
    return r?.success ? { sent: true, id: r.id || null } : { sent: false, reason: r?.reason || 'send_failed' };
}

module.exports = { render, sendTemplate };
