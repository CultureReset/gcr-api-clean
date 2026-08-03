// ============================================================
// INGEST — read a business's own links, propose real column values
// ============================================================
//
// Give it a website, a Google Business page, an Airbnb listing, a Facebook
// page — any URLs — and a table. It fetches them, reads the text, and returns
// PROPOSED ROWS shaped to that table's actual columns.
//
// ── Two rules it exists to enforce ──────────────────────────────────────
//
// 1. THE COLUMNS COME FROM THE SCHEMA, NOT FROM A LIST IN THIS FILE.
//
//    routes/admin.js already has an AI parser, but it carries a hardcoded map
//    of five data types — menu, drinks, happy_hour, specials, events — each
//    with fixed field hints. It can fill a menu and nothing else. It cannot
//    touch bookable_resources or marina_slips, and adding a table means
//    editing that map.
//
//    Here the target table is a parameter, its columns are read from the live
//    schema, and the model is told to fill exactly those. Any table, no code
//    change.
//
// 2. ONE FACT PER COLUMN. NO PROSE BLOBS.
//
//    A description reading "Night bowfishing; ages 6+ welcome. 4 hours,
//    leaves 8 PM. $500 up to 4 people." is five facts crammed into one field
//    while duration, departure time, price, capacity and minimum age all sit
//    empty beside it. That is the same failure as putting JSON in a column:
//    the data is present but cannot be searched, filtered or summed.
//
//    So the prompt below requires every fact that has a column to go IN that
//    column, and forbids repeating it in the prose field.
//
// ── Nothing is written ──────────────────────────────────────────────────
//
// This endpoint only proposes. Extraction from a web page is a guess, and a
// guess must not land in the database unreviewed. The dashboard shows what it
// found, per field, with the source URL, and a person applies it through the
// ordinary write routes.

const express = require('express');
const db = require('../db');
const { adminRequired } = require('../middleware/auth');

const router = express.Router();

const SUPABASE_URL = process.env.GCR_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY =
    process.env.GCR_SUPABASE_SERVICE_KEY ||
    process.env.GCR_SUPABASE_KEY ||
    process.env.SUPABASE_KEY;

/** Per-page fetch ceiling — a slow site must not hang the request. */
const FETCH_TIMEOUT_MS = 12_000;

/** Characters of page text kept per URL. */
const TEXT_PER_PAGE = 12_000;

const NEVER_FILL = new Set(['id', 'entity_slug', 'entity_id', 'site_id', 'created_at', 'updated_at']);

/* ── schema ──────────────────────────────────────────────────────────────── */

async function columnsFor(tableName) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) throw new Error(`schema read failed: HTTP ${res.status}`);
    const spec = await res.json();
    const def = (spec.definitions || {})[tableName];
    if (!def) {
        const err = new Error(`"${tableName}" is not a table in this schema`);
        err.status = 400;
        throw err;
    }
    if (!def.properties?.entity_slug) {
        const err = new Error(`"${tableName}" is not slug-keyed, so it is not part of a business profile`);
        err.status = 400;
        throw err;
    }
    return Object.entries(def.properties)
        .filter(([name]) => !NEVER_FILL.has(name))
        .map(([name, meta]) => ({ name, type: meta.format || meta.type || 'text' }));
}

/* ── fetching ────────────────────────────────────────────────────────────── */

/** Strip a page to readable text. Crude on purpose — the model tolerates it. */
function toText(html) {
    return String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

async function readPage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GCR-Ingest/1.0)' },
        });
        if (!res.ok) return { url, ok: false, error: `HTTP ${res.status}` };
        const body = await res.text();
        const text = toText(body).slice(0, TEXT_PER_PAGE);
        return { url, ok: true, chars: text.length, text };
    } catch (e) {
        // A site that blocks bots or times out is reported, not hidden — a
        // silently skipped source looks identical to a source with nothing in
        // it, and those need different fixes.
        return { url, ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message };
    } finally {
        clearTimeout(timer);
    }
}

/* ── POST /api/admin/gcr/ingest/:slug/:table ─────────────────────────────── */

router.post('/ingest/:slug/:table', adminRequired, async (req, res) => {
    const { slug, table: tableName } = req.params;
    const urls = Array.isArray(req.body?.urls) ? req.body.urls.filter(Boolean).slice(0, 8) : [];
    const extra = String(req.body?.notes || '').slice(0, 4000);

    if (!urls.length && !extra) {
        return res.status(400).json({ error: 'Supply at least one URL, or notes to parse' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured on the API' });
    }

    try {
        const [columns, entityRead] = await Promise.all([
            columnsFor(tableName),
            db.from('entity').select('slug, name, entity_type, city').eq('slug', slug).maybeSingle(),
        ]);
        if (!entityRead.data) return res.status(404).json({ error: `No business with slug "${slug}"` });

        const pages = await Promise.all(urls.map(readPage));
        const usable = pages.filter((p) => p.ok && p.text);
        if (!usable.length && !extra) {
            return res.status(422).json({
                error: 'None of those URLs could be read',
                sources: pages,
            });
        }

        const columnList = columns
            .map((c) => `  ${c.name} (${c.type})`)
            .join('\n');

        const corpus = [
            ...usable.map((p) => `SOURCE: ${p.url}\n${p.text}`),
            extra ? `SOURCE: notes\n${extra}` : null,
        ].filter(Boolean).join('\n\n---\n\n');

        const prompt = `You are filling rows of the table "${tableName}" for the business "${entityRead.data.name}" (${entityRead.data.entity_type || 'unknown type'}${entityRead.data.city ? ', ' + entityRead.data.city : ''}).

These are the ONLY fields that exist. Use the exact names:
${columnList}

Rules:
- Extract only what the sources actually state. Never invent, never infer a plausible-sounding value. Omit a field rather than guess.
- ONE FACT PER FIELD. If a fact has its own column, it goes in that column and NOT in any prose field. A duration of 4 hours belongs in a duration field, not in a description; a price of $500 belongs in a price field; "ages 6+" belongs in a minimum-age field; "up to 4 people" belongs in a capacity field. A description that repeats those numbers is wrong.
- A prose field should hold only what has no column of its own.
- Numbers must be plain numbers, no currency symbols or units. Times as HH:MM (24h). Dates as YYYY-MM-DD. Booleans as true/false.
- Return one object per distinct thing described. If the sources describe three boats, return three objects.

Return ONLY a JSON object of this shape, no markdown fencing:
{"rows":[{"field":"value"}],"notes":"anything you could not place, or ambiguity worth a human eye"}

SOURCES:
${corpus}`;

        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const message = await client.messages.create({
            model: process.env.INGEST_MODEL || 'claude-opus-4-7',
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
        });

        const raw = message.content?.[0]?.type === 'text' ? message.content[0].text : '';
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) return res.status(422).json({ error: 'Model did not return JSON', raw: raw.slice(0, 500) });
            parsed = JSON.parse(match[0]);
        }

        // Drop anything that is not a real column — the model is capable of
        // inventing a field name, and a proposal containing one would fail at
        // write time with a confusing error.
        const allowed = new Set(columns.map((c) => c.name));
        const rows = (Array.isArray(parsed.rows) ? parsed.rows : []).map((row) => {
            const clean = {};
            const dropped = [];
            for (const [k, v] of Object.entries(row || {})) {
                if (allowed.has(k)) clean[k] = v;
                else dropped.push(k);
            }
            return { values: clean, dropped };
        });

        res.json({
            slug,
            table: tableName,
            proposed: rows,
            model_notes: parsed.notes || null,
            sources: pages.map(({ url, ok, error, chars }) => ({ url, ok, error: error || null, chars: chars || 0 })),
            applied: false,
            note: 'Nothing has been saved. Review each field, then apply through the normal row editor.',
        });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

module.exports = router;
