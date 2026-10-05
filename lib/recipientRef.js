// ============================================================
// RECIPIENT REFERENCES — an address named by id, resolved inside gcr (DECISIONS #87)
// ============================================================
//
// Paperclip never holds a customer's address (#37): an automation or an agent
// that messages a customer names the record the address is on, and gcr looks
// it up. The business MCP's send_message (routes/mcp.js) takes
//
//   to_ref: { contract: 'booking.records', id }   a row of a data contract
//           { customer_id }                        shorthand for customers.items
//
// and this module turns it into the address for the channel asked for,
// reading the row through the contract registry (lib/dataContracts.js) and
// only within the caller's business: the lookup filters on the slug the token
// resolved to and the row's id, so a reference cannot reach another
// business's row. The address is returned to the caller in this process only;
// the tool result never carries it.
//
// Which column is the address is a property of the row, not of the reference:
// the first of the channel's address columns that holds a value, on the row
// or in its `details` (the booking shapes lib/businessEvents.js reads).
//
// resolveRecipient(slug, channel, toRef) → { address } or { reason }
//   reasons: bad_ref, unknown_contract, not_found, no_address

const supabase = require('../db');
const dataContracts = require('./dataContracts');

const ADDRESS_COLUMNS = Object.freeze({
    email: ['email', 'customer_email', 'guest_email', 'contact_email'],
    sms: ['phone', 'customer_phone', 'guest_phone', 'contact_phone', 'mobile'],
});

const CUSTOMERS_CONTRACT = 'customers.items';

/** The { contract, id } a reference names, or null when it is not one. */
function normalizeRef(toRef) {
    if (!toRef || typeof toRef !== 'object' || Array.isArray(toRef)) return null;
    if (toRef.customer_id !== undefined && toRef.customer_id !== null && toRef.customer_id !== '') {
        return { contract: CUSTOMERS_CONTRACT, id: String(toRef.customer_id) };
    }
    const contract = typeof toRef.contract === 'string' ? toRef.contract.trim() : '';
    const id = toRef.id;
    if (!contract || id === undefined || id === null || id === '') return null;
    return { contract, id: String(id) };
}

/** The address on a row for a channel, or null. */
function addressOn(row, channel) {
    const columns = ADDRESS_COLUMNS[channel];
    if (!columns || !row) return null;
    const details = row.details && typeof row.details === 'object' ? row.details : {};
    for (const source of [row, details]) {
        for (const column of columns) {
            const v = source[column];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
    }
    return null;
}

/**
 * Resolve a reference to the address for `channel`, within `slug` only.
 * Never throws on a bad reference; a database error is thrown.
 */
async function resolveRecipient(slug, channel, toRef) {
    if (!slug) return { reason: 'bad_ref' };
    const ref = normalizeRef(toRef);
    if (!ref) return { reason: 'bad_ref' };
    if (!ADDRESS_COLUMNS[channel]) return { reason: 'bad_ref' };
    const entry = dataContracts.isContractName(ref.contract) ? dataContracts.contractFor(ref.contract) : null;
    if (!entry || entry.pivot || entry.scalar) return { reason: 'unknown_contract' };

    let query = supabase.from(entry.table).select('*')
        .eq(entry.idColumn || 'id', ref.id)
        .eq(entry.slugColumn || 'entity_slug', slug);
    for (const [column, value] of Object.entries(entry.filter || {})) query = query.eq(column, value);
    const { data: row, error } = await query.maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return { reason: 'not_found' };
    const address = addressOn(row, channel);
    return address ? { address, contract: ref.contract, id: ref.id } : { reason: 'no_address' };
}

module.exports = { resolveRecipient, normalizeRef, addressOn, ADDRESS_COLUMNS };
