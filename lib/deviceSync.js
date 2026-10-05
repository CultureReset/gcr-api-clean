// ============================================================
// DEVICE SYNC — a computer's status, up to the registry (DECISIONS #73)
// ============================================================
//
// Paperclip keeps the device registry (which computers and phones a company
// has, whether they are online). The live facts come from the computer's
// heartbeat to the relay (routes/nodes.js POST /heartbeat {version, health}).
// On every heartbeat this derives the registry's view of it:
//
//   { companyId, nodeId, version, capabilities, phones: [{ deviceId, sim,
//     online, number? }], lastSeenAt }
//
// and posts it, signed (CONTRACT §3), to Paperclip's
// POST /api/nextgent/devices/status — when the version, the capabilities or
// the phones changed, or when the last push is older than
// DEVICE_STATUS_PUSH_SECONDS (a throttled last_seen; default 300). The
// company is company_links' for the node's business; a business that is not
// linked has no registry to tell.
//
// What was last pushed, and when, lives on the node row:
// ghost_nodes.registry_state / registry_synced_at (sql/nextgent_nodes_registry.sql).
// Until that file is applied nothing is pushed. Nothing here ever fails the
// heartbeat: every outcome is { pushed, reason? }.
//
// The health shape is nextgent-platform's health.py: health.capabilities is
// the box's capability list; health.phone is its phone (device_id, online,
// sim, …), or health.phones several of them (DECISIONS #72).

const supabase = require('../db');
const { signedPost } = require('./serviceSigning');
const { companyForSlug } = require('./companyLinks');
const { envInt } = require('./env');

const STATUS_PATH = '/api/nextgent/devices/status';
const pushSeconds = () => envInt('DEVICE_STATUS_PUSH_SECONDS', 300);

const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : v == null ? null : String(v));

function phoneOf(p) {
    if (!p || typeof p !== 'object') return null;
    const deviceId = strOrNull(p.device_id ?? p.deviceId ?? p.id ?? p.serial_hint);
    const number = strOrNull(p.number ?? p.phone_number ?? p.msisdn);
    return {
        deviceId,
        sim: strOrNull(p.sim ?? p.sim_status),
        online: p.online === true,
        ...(number ? { number } : {}),
    };
}

/** The registry's view of one heartbeat. Always the same keys, never undefined. */
function statusFrom({ nodeId, version, health, lastSeenAt }) {
    const h = health && typeof health === 'object' ? health : {};
    const list = Array.isArray(h.phones) ? h.phones : h.phone ? [h.phone] : [];
    return {
        nodeId,
        version: strOrNull(version),
        capabilities: Array.isArray(h.capabilities) ? h.capabilities.filter((c) => typeof c === 'string') : [],
        phones: list.map(phoneOf).filter(Boolean),
        lastSeenAt: lastSeenAt || null,
    };
}

/** The part of a status whose change triggers a push. */
const stateOf = (s) => ({ version: s.version, capabilities: s.capabilities, phones: s.phones });
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Push a node's status to the registry if it is due.
 * Resolves { pushed: true, payload } or { pushed: false, reason }. Never throws.
 */
async function syncStatus({ node, version, health, lastSeenAt, now = new Date(), post = signedPost }) {
    try {
        const { data: kept, error } = await supabase.from('ghost_nodes')
            .select('registry_state, registry_synced_at').eq('id', node.id).maybeSingle();
        if (error) return { pushed: false, reason: 'not_set_up' }; // sql/nextgent_nodes_registry.sql not applied

        const status = statusFrom({ nodeId: node.id, version, health, lastSeenAt });
        const state = stateOf(status);
        const syncedAt = kept?.registry_synced_at ? new Date(kept.registry_synced_at).getTime() : 0;
        const due = now.getTime() - syncedAt >= pushSeconds() * 1000;
        if (same(kept?.registry_state, state) && !due) return { pushed: false, reason: 'unchanged' };

        const companyId = await companyForSlug(node.entity_slug);
        if (!companyId) return { pushed: false, reason: 'not_linked' };

        const payload = { companyId, ...status };
        await post(STATUS_PATH, payload);
        await supabase.from('ghost_nodes')
            .update({ registry_state: state, registry_synced_at: now.toISOString() }).eq('id', node.id);
        return { pushed: true, payload };
    } catch (err) {
        return { pushed: false, reason: String(err.message || err).slice(0, 300) };
    }
}

module.exports = { syncStatus, statusFrom, STATUS_PATH };
