// Guest trial: a signed-out visitor (identified by the gcr_guest_id UUID the
// client sends as X-Guest-Id) can use the concierge and Trip Swipe for a
// limited amount of active time before phone sign-in is required.
//
// The clock lives here, server-side, keyed by guest id, so clearing the
// browser's cache of it (or reloading) doesn't reset it. The client caches
// the same numbers only to show nudges without a round trip.
//
// Table: tourist_guest_usage (sql/2026-10-16-guest-trial.sql).

const mainDb = require('../db');

const GUEST_LIMIT_MS  = Number(process.env.GUEST_TRIAL_MS || 10 * 60 * 1000);
// Nudge points (fractions of the limit) the client shows a gentle prompt at.
const NUDGE_AT_MS     = [3 * 60 * 1000, 7 * 60 * 1000];
// One heartbeat can never add more than this — a client can't fast-forward,
// and a tab left open in the background can't silently burn the whole trial.
const MAX_BEAT_MS     = 60 * 1000;

function clampDelta(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n), MAX_BEAT_MS);
}

function statusFrom(row) {
    const used = Number(row?.used_ms || 0);
    return {
        guest: true,
        used_ms: used,
        limit_ms: GUEST_LIMIT_MS,
        remaining_ms: Math.max(0, GUEST_LIMIT_MS - used),
        nudge_at_ms: NUDGE_AT_MS,
        signin_required: used >= GUEST_LIMIT_MS || !!row?.merged_into,
        first_seen: row?.first_seen || null,
    };
}

async function getUsage(guestId) {
    const { data } = await mainDb.from('tourist_guest_usage')
        .select('guest_id, first_seen, used_ms, chat_count, merged_into')
        .eq('guest_id', guestId).maybeSingle();
    return data || null;
}

// Add active time (and optionally a chat turn). Creates the row on first sight.
// Read-then-write is fine here: the worst race is two heartbeats both landing,
// each capped at MAX_BEAT_MS.
async function recordUsage(guestId, { deltaMs = 0, chat = false } = {}) {
    const existing = await getUsage(guestId);
    const now = new Date().toISOString();
    const row = {
        guest_id:   guestId,
        first_seen: existing?.first_seen || now,
        last_seen:  now,
        used_ms:    Number(existing?.used_ms || 0) + clampDelta(deltaMs),
        chat_count: Number(existing?.chat_count || 0) + (chat ? 1 : 0),
    };
    const { error } = await mainDb.from('tourist_guest_usage').upsert(row, { onConflict: 'guest_id' });
    if (error) console.warn('[guestUsage] upsert failed:', error.message);
    return statusFrom({ ...existing, ...row });
}

module.exports = { GUEST_LIMIT_MS, NUDGE_AT_MS, MAX_BEAT_MS, clampDelta, statusFrom, getUsage, recordUsage };
