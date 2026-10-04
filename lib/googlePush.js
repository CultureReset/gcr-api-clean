// ============================================================
// GOOGLE PUSH — one change, pushed to the business's Google profile (plan §9)
// ============================================================
//
// When a fact changes (hours, special hours, attributes, menus, services,
// posts), the write that changed it calls noteTableWrite(slug, table). Which
// tables carry which fact is data (google_fact_sources), so a business section
// added later is mapped with an insert.
//
// The queue (google_push_queue) holds one pending push per business and fact
// (the latest data is read when it is sent, so ten edits to the hours are one
// push), and one per post. drain() sends them:
//
//   - only for a business that connected Google and picked its location;
//   - only for a verified profile (Google's Voice of Merchant state, checked
//     and cached in google_push_state);
//   - at most GOOGLE_EDITS_PER_MINUTE edits per profile per minute (Google's
//     published limit is configuration, not code);
//   - a failed push is retried GOOGLE_PUSH_MAX_ATTEMPTS times, then the owner
//     is told.
//
// After a push, Google's copy is read back and kept as a low-trust
// observation (fact_observations, trust rank from fact_source_ranks). Where
// Google's copy differs from ours — a suggested edit, or a push Google
// changed — the owner is told so it can be reviewed.
//
// Status for the owner: GET /api/google-business/push-status.

const supabase = require('../db');
const gbp = require('./googleBusinessApi');
const { notifyOwner } = require('./notify');
const { envInt, envStr } = require('./env');

const SNAPSHOT_KINDS = new Set(['hours', 'special_hours', 'attributes', 'menus', 'services']);
const KINDS = new Set([...SNAPSHOT_KINDS, 'posts']);
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const OBSERVATION_SOURCE = 'google';

const nowIso = () => new Date().toISOString();
const missing = (error) => /(does not exist|schema cache)/i.test(error?.message || '');

/* ── which tables are which facts ─────────────────────────────────────── */

let sourcesCache = { at: 0, map: null };
async function factSources() {
    if (sourcesCache.map && Date.now() - sourcesCache.at < 5 * 60 * 1000) return sourcesCache.map;
    const { data, error } = await supabase.from('google_fact_sources').select('table_name, kind');
    const map = {};
    if (!error) for (const r of data || []) if (KINDS.has(r.kind)) (map[r.kind] ||= []).push(r.table_name);
    sourcesCache = { at: Date.now(), map };
    return map;
}

async function kindForTable(table) {
    const map = await factSources();
    return Object.keys(map).find((k) => map[k].includes(table)) || null;
}

/**
 * A business's data changed. Queue a push when the table is one of the
 * mapped facts and the business is connected to Google. Never throws.
 */
async function noteTableWrite(slug, table, row = null) {
    try {
        if (!slug || !table) return null;
        const kind = await kindForTable(table);
        if (!kind) return null;
        const conn = await gbp.connection(slug);
        if (!conn?.account_id) return null;
        return await enqueue(slug, kind, kind === 'posts' ? row : null);
    } catch (e) {
        console.error('[google-push] queue', slug, table, e.message);
        return null;
    }
}

async function enqueue(slug, kind, row = null) {
    const ref = kind === 'posts' ? String(row?.id ?? '') : '';
    if (kind === 'posts' && !ref) return null;
    const { data: pending } = await supabase.from('google_push_queue').select('id')
        .eq('entity_slug', slug).eq('kind', kind).eq('ref', ref).eq('status', 'pending').maybeSingle();
    if (pending) {
        await supabase.from('google_push_queue').update({ queued_at: nowIso(), attempts: 0, next_attempt_at: null }).eq('id', pending.id);
        return pending;
    }
    const { data, error } = await supabase.from('google_push_queue').insert({
        entity_slug: slug, kind, ref, status: 'pending', attempts: 0, queued_at: nowIso(),
        payload: kind === 'posts' ? row : null,
    }).select('*').single();
    if (error && !missing(error)) console.error('[google-push] enqueue', error.message);
    return data || null;
}

/* ── reading our side ─────────────────────────────────────────────────── */

async function rowsFor(kind, slug) {
    const tables = (await factSources())[kind] || [];
    const out = [];
    for (const t of tables) {
        const { data } = await supabase.from(t).select('*').eq('entity_slug', slug).limit(envInt('GOOGLE_PUSH_ROW_LIMIT', 500));
        out.push(...(data || []));
    }
    return out;
}

const pick = (row, ...names) => { for (const n of names) if (row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n]; return null; };

function clock(value) {
    const m = String(value || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/);
    if (!m) return null;
    let h = Number(m[1]);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return h > 24 ? null : { hours: h, minutes: Number(m[2] || 0) };
}

function dayName(v) {
    if (v === null || v === undefined || v === '') return null;
    if (/^\d+$/.test(String(v))) return DAYS[Number(v) % 7];
    const s = String(v).trim().toUpperCase();
    return DAYS.find((d) => d.startsWith(s.slice(0, 3))) || null;
}

function money(amount) {
    const n = Number(amount);
    const currency = (envStr('DEFAULT_CURRENCY') || '').toUpperCase();
    if (!Number.isFinite(n) || !currency) return null;
    const units = Math.trunc(n);
    return { currencyCode: currency, units: String(units), nanos: Math.round((n - units) * 1e9) };
}

const BUILDERS = {
    async hours(slug) {
        const periods = [];
        for (const r of await rowsFor('hours', slug)) {
            if (pick(r, 'is_closed', 'closed') === true) continue;
            const day = dayName(pick(r, 'day_of_week', 'day'));
            const open = clock(pick(r, 'opens_at', 'open_time', 'open'));
            const close = clock(pick(r, 'closes_at', 'close_time', 'close'));
            if (!day || !open || !close) continue;
            const overnight = close.hours * 60 + close.minutes <= open.hours * 60 + open.minutes;
            periods.push({ openDay: day, openTime: open, closeDay: overnight ? DAYS[(DAYS.indexOf(day) + 1) % 7] : day, closeTime: close });
        }
        return { mask: 'regularHours', body: { regularHours: { periods } }, ours: periods };
    },
    async special_hours(slug) {
        const today = new Date().toISOString().slice(0, 10);
        const specialHourPeriods = [];
        for (const r of await rowsFor('special_hours', slug)) {
            const date = String(pick(r, 'date', 'exception_date') || '').slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) continue;
            const [y, m, d] = date.split('-').map(Number);
            const closed = pick(r, 'closed', 'is_closed') === true;
            const open = clock(pick(r, 'open_time', 'opens_at'));
            const close = clock(pick(r, 'close_time', 'closes_at'));
            const period = { startDate: { year: y, month: m, day: d }, closed: closed || !open || !close };
            if (!period.closed) Object.assign(period, { openTime: open, closeTime: close });
            specialHourPeriods.push(period);
        }
        return { mask: 'specialHours', body: { specialHours: { specialHourPeriods } }, ours: specialHourPeriods };
    },
    async services(slug, loc) {
        const category = loc?.categories?.primaryCategory?.name;
        if (!category) throw new Error('Google has no primary category for this location, so services cannot be listed');
        const serviceItems = (await rowsFor('services', slug)).map((r) => {
            const name = pick(r, 'name', 'service_name', 'title', 'item_name');
            if (!name) return null;
            const price = money(pick(r, 'price', 'price_from', 'base_price'));
            return {
                freeFormServiceItem: { category, label: { displayName: String(name).slice(0, 140), ...(pick(r, 'description') ? { description: String(r.description).slice(0, 300) } : {}) } },
                ...(price ? { price } : {}),
            };
        }).filter(Boolean);
        return { mask: 'serviceItems', body: { serviceItems }, ours: serviceItems };
    },
};

async function attributesPush(slug, names) {
    const { data: map } = await supabase.from('google_attribute_map').select('attribute_key, google_attribute_id, value_type');
    const byKey = Object.fromEntries((map || []).map((m) => [m.attribute_key, m]));
    const attributes = [];
    for (const r of await rowsFor('attributes', slug)) {
        const m = byKey[pick(r, 'key', 'attribute_key')];
        if (!m) continue;
        const raw = pick(r, 'value', 'value_text');
        const value = m.value_type === 'BOOL' ? ['true', '1', 'yes', true].includes(typeof raw === 'string' ? raw.toLowerCase() : raw) : raw;
        attributes.push({ name: `attributes/${m.google_attribute_id}`, values: [value] });
    }
    if (!attributes.length) return { skipped: 'no mapped attributes' };
    const mask = attributes.map((a) => a.name).join(',');
    await gbp.gbpFetch(slug, `${gbp.API.info()}/${names.v1}/attributes?attributeMask=${encodeURIComponent(mask)}`, {
        method: 'PATCH', body: JSON.stringify({ name: `${names.v1}/attributes`, attributes }),
    });
    return { edits: 1, ours: attributes };
}

async function menusPush(slug, names) {
    if (!names.v4) throw new Error('The selected location has no account path for menus');
    const sections = {};
    for (const r of await rowsFor('menus', slug)) {
        if (pick(r, 'is_active', 'active') === false) continue;
        const name = pick(r, 'name', 'item_name', 'title');
        if (!name) continue;
        const section = String(pick(r, 'category', 'section', 'course') || envStr('GOOGLE_MENU_DEFAULT_SECTION', 'Menu'));
        const price = money(pick(r, 'price'));
        (sections[section] ||= []).push({
            labels: [{ displayName: String(name).slice(0, 140), ...(pick(r, 'description') ? { description: String(r.description).slice(0, 1000) } : {}) }],
            ...(price ? { attributes: { price } } : {}),
        });
    }
    const menus = [{ labels: [{ displayName: envStr('GOOGLE_MENU_NAME', 'Menu') }], sections: Object.entries(sections).map(([label, items]) => ({ labels: [{ displayName: label }], items })) }];
    await gbp.gbpFetch(slug, `${gbp.API.v4()}/${names.v4}/foodMenus`, { method: 'PATCH', body: JSON.stringify({ name: `${names.v4}/foodMenus`, menus }) });
    return { edits: 1 };
}

async function postPush(slug, names, row) {
    if (!names.v4) throw new Error('The selected location has no account path for posts');
    const summary = row && pick(row, 'summary', 'body', 'content', 'text', 'caption', 'description', 'title');
    if (!summary) return { skipped: 'the post has no text' };
    const lang = envStr('GOOGLE_POST_LANGUAGE');
    const link = pick(row, 'url', 'link');
    await gbp.gbpFetch(slug, `${gbp.API.v4()}/${names.v4}/localPosts`, {
        method: 'POST',
        body: JSON.stringify({
            topicType: 'STANDARD',
            summary: String(summary).slice(0, 1500),
            ...(lang ? { languageCode: lang } : {}),
            ...(link ? { callToAction: { actionType: 'LEARN_MORE', url: link } } : {}),
        }),
    });
    return { edits: 1 };
}

/* ── verification and the edit window ─────────────────────────────────── */

async function stateFor(slug) {
    const { data } = await supabase.from('google_push_state').select('*').eq('entity_slug', slug).maybeSingle();
    return data || { entity_slug: slug };
}

async function saveState(slug, patch) {
    await supabase.from('google_push_state').upsert({ entity_slug: slug, ...patch, updated_at: nowIso() }, { onConflict: 'entity_slug' });
}

/** Is this profile verified? Google's Voice of Merchant state, cached. */
async function isVerified(slug, names, state, now) {
    const recheck = envInt('GOOGLE_VERIFY_RECHECK_HOURS', 24) * 3600 * 1000;
    if (state.verified === true && state.verified_checked_at && now - new Date(state.verified_checked_at) < recheck) return true;
    const vom = await gbp.gbpFetch(slug, `${gbp.API.verifications()}/${names.v1}/VoiceOfMerchantState`);
    const verified = vom?.hasVoiceOfMerchant === true;
    await saveState(slug, { verified, verified_checked_at: now.toISOString() });
    return verified;
}

/** Edits left in this business's one-minute window. */
function editsLeft(state, now, perMinute) {
    const start = state.window_start ? new Date(state.window_start) : null;
    if (!start || now - start >= 60 * 1000) return { left: perMinute, windowStart: now, used: 0 };
    return { left: Math.max(perMinute - (state.edits_in_window || 0), 0), windowStart: start, used: state.edits_in_window || 0 };
}

/* ── read-back: Google's copy as a low-trust source ───────────────────── */

async function sourceRank(source) {
    const { data } = await supabase.from('fact_source_ranks').select('rank').eq('source', source).maybeSingle();
    return data?.rank ?? null;
}

const canon = (v) => JSON.stringify(v ?? null, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.entries(val).filter(([, x]) => x !== 0 && x !== false && x !== null && x !== undefined).sort(([a], [b]) => a.localeCompare(b))) : val));

/**
 * Read Google's copy of the location and keep it as an observation. Returns
 * the facts that differ from ours (which the owner is asked to review).
 */
async function readBack(slug, names, ours = {}) {
    const loc = await gbp.gbpFetch(slug, `${gbp.API.info()}/${names.v1}?readMask=regularHours,specialHours,serviceItems,categories`);
    const rank = await sourceRank(OBSERVATION_SOURCE);
    const differs = [];
    const facts = { hours: loc.regularHours?.periods || [], special_hours: loc.specialHours?.specialHourPeriods || [], services: loc.serviceItems || [] };
    for (const [fact, value] of Object.entries(facts)) {
        const mine = ours[fact];
        const different = mine !== undefined && canon(mine) !== canon(value);
        if (different) differs.push(fact);
        await supabase.from('fact_observations').insert({
            entity_slug: slug, fact, source: OBSERVATION_SOURCE, trust_rank: rank, value, observed_at: nowIso(),
            differs_from_ours: mine === undefined ? null : different,
            review_status: different ? 'pending' : null,
        });
    }
    if (differs.length) {
        await notifyOwner(slug, {
            kind: 'review',
            title: 'Google shows something different from your profile',
            body: `Google's copy of your ${differs.join(', ').replace(/_/g, ' ')} does not match yours. It may be a suggested edit from the public.`,
            ref: `google-diff:${differs.join(',')}:${new Date().toISOString().slice(0, 10)}`,
            link: process.env.OWNER_REVIEW_PATH || null,
        });
    }
    return { differs, location: loc };
}

/* ── draining the queue ───────────────────────────────────────────────── */

async function markRow(id, patch) {
    await supabase.from('google_push_queue').update(patch).eq('id', id);
}

/**
 * Send what is due. Resolves a summary; never throws for one business's
 * failure.
 */
async function drain({ now = new Date(), limit = envInt('GOOGLE_PUSH_BATCH', 100) } = {}) {
    const perMinute = envInt('GOOGLE_EDITS_PER_MINUTE', 0);
    if (!perMinute) return { skipped: 'GOOGLE_EDITS_PER_MINUTE is not set' };
    const maxAttempts = envInt('GOOGLE_PUSH_MAX_ATTEMPTS', 5);
    const { data: rows, error } = await supabase.from('google_push_queue').select('*')
        .eq('status', 'pending').order('queued_at', { ascending: true }).limit(limit);
    if (error) return { error: error.message };

    const summary = { pending: (rows || []).length, pushed: 0, blocked: 0, failed: 0, deferred: 0, read_back: 0 };
    const bySlug = new Map();
    for (const r of rows || []) {
        if (r.next_attempt_at && new Date(r.next_attempt_at) > now) { summary.deferred += 1; continue; }
        if (!bySlug.has(r.entity_slug)) bySlug.set(r.entity_slug, []);
        bySlug.get(r.entity_slug).push(r);
    }

    for (const [slug, queue] of bySlug) {
        const conn = await gbp.connection(slug);
        const names = gbp.locationNames(conn?.account_id);
        if (!conn || !names) {
            for (const r of queue) await markRow(r.id, { status: 'blocked', last_error: 'Google is not connected, or no location is selected' });
            summary.blocked += queue.length;
            continue;
        }
        let state = await stateFor(slug);
        try {
            if (!(await isVerified(slug, names, state, now))) {
                for (const r of queue) await markRow(r.id, { status: 'blocked', last_error: 'The Google profile is not verified' });
                summary.blocked += queue.length;
                continue;
            }
        } catch (e) {
            await saveState(slug, { last_error: e.message });
            summary.deferred += queue.length;
            continue;
        }
        state = await stateFor(slug);
        let win = editsLeft(state, now, perMinute);
        const ours = {};
        let pushedHere = 0;
        let location = null;

        for (const r of queue) {
            if (win.left <= 0) { summary.deferred += 1; continue; }
            try {
                let out;
                if (BUILDERS[r.kind]) {
                    if (r.kind === 'services' && !location) location = await gbp.gbpFetch(slug, `${gbp.API.info()}/${names.v1}?readMask=categories`);
                    const built = await BUILDERS[r.kind](slug, location);
                    await gbp.gbpFetch(slug, `${gbp.API.info()}/${names.v1}?updateMask=${built.mask}`, { method: 'PATCH', body: JSON.stringify(built.body) });
                    ours[r.kind] = built.ours;
                    out = { edits: 1 };
                } else if (r.kind === 'attributes') {
                    out = await attributesPush(slug, names);
                } else if (r.kind === 'menus') {
                    out = await menusPush(slug, names);
                } else if (r.kind === 'posts') {
                    out = await postPush(slug, names, r.payload);
                } else {
                    out = { skipped: `unknown kind ${r.kind}` };
                }
                const used = out.edits || 0;
                win = { ...win, left: win.left - used, used: win.used + used };
                await markRow(r.id, { status: out.skipped ? 'skipped' : 'done', pushed_at: now.toISOString(), last_error: out.skipped || null, attempts: (r.attempts || 0) + 1 });
                if (!out.skipped) { summary.pushed += 1; pushedHere += 1; }
            } catch (e) {
                const attempts = (r.attempts || 0) + 1;
                const finalFail = attempts >= maxAttempts || e.code === 'reconnect' || e.status === 403;
                await markRow(r.id, {
                    status: finalFail ? 'failed' : 'pending', attempts, last_error: String(e.message).slice(0, 500),
                    next_attempt_at: finalFail ? null : new Date(now.getTime() + attempts * envInt('GOOGLE_PUSH_RETRY_SECONDS', 300) * 1000).toISOString(),
                });
                if (finalFail) {
                    summary.failed += 1;
                    await notifyOwner(slug, {
                        kind: 'failed_action',
                        title: `Your ${r.kind.replace(/_/g, ' ')} did not reach Google`,
                        body: String(e.message).slice(0, 500),
                        ref: `google-push:${r.id}`,
                        link: process.env.OWNER_GOOGLE_PATH || null,
                    });
                }
            }
        }
        await saveState(slug, { window_start: win.windowStart.toISOString(), edits_in_window: win.used, ...(pushedHere ? { last_push_at: now.toISOString(), last_error: null } : {}) });

        if (pushedHere) {
            try {
                await readBack(slug, names, ours);
                summary.read_back += 1;
            } catch (e) {
                await saveState(slug, { last_error: `Read-back failed: ${e.message}` });
            }
        }
    }
    return summary;
}

/** What the owner sees: connection, verification, the queue, the last push. */
async function status(slug) {
    const conn = await gbp.connection(slug);
    const state = await stateFor(slug);
    const { data: queue } = await supabase.from('google_push_queue').select('kind, status, attempts, last_error, queued_at, pushed_at')
        .eq('entity_slug', slug).order('queued_at', { ascending: false }).limit(50);
    const { data: diffs } = await supabase.from('fact_observations').select('fact, observed_at, review_status')
        .eq('entity_slug', slug).eq('source', OBSERVATION_SOURCE).eq('review_status', 'pending').limit(20);
    return {
        connected: !!conn,
        reconnect_needed: !!conn?.extra?.reconnect_needed,
        location_selected: !!gbp.locationNames(conn?.account_id),
        verified: state.verified ?? null,
        verified_checked_at: state.verified_checked_at || null,
        last_push_at: state.last_push_at || null,
        last_error: state.last_error || null,
        edits_per_minute: envInt('GOOGLE_EDITS_PER_MINUTE', 0) || null,
        queue: queue || [],
        google_differs: diffs || [],
    };
}

module.exports = {
    KINDS,
    noteTableWrite,
    enqueue,
    drain,
    readBack,
    status,
    _resetSources: () => { sourcesCache = { at: 0, map: null }; },
};
