// The address a business forwards its email to (plan §9, "How data comes in").
//
// One copy of the convention, both directions: forwardingAddressFor() makes
// the address a business is told to forward to, slugFromAddress() takes the
// slug back out of an inbound TO address (routes/email-parser.js,
// routes/email-webhook.js). Domain and prefix are configuration:
//
//   INTAKE_EMAIL_DOMAIN   the inbound-parse domain (required for an address)
//   INTAKE_EMAIL_PREFIX   what goes before the slug (see DEFAULT_PREFIX)
//
// Without a domain there is no address, and callers say so rather than
// inventing one.

// The prefix every address handed out so far carries. Changing it strands the
// forwarding rules businesses already set up, so it is the fallback only;
// INTAKE_EMAIL_PREFIX overrides it.
const DEFAULT_PREFIX = 'gcr-';

const domain = () => (process.env.INTAKE_EMAIL_DOMAIN || '').trim().replace(/^@/, '').toLowerCase();
const prefix = () => process.env.INTAKE_EMAIL_PREFIX ?? DEFAULT_PREFIX;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function forwardingAddressFor(slug) {
    const d = domain();
    if (!slug || !d) return null;
    return `${prefix()}${slug}@${d}`;
}

/**
 * The slug a TO header is addressed to, or null. A header may hold several
 * addresses and display names; the first one on the intake domain wins. With
 * no INTAKE_EMAIL_DOMAIN set, any domain is accepted (the parse provider only
 * delivers mail for its own domain anyway).
 */
function slugFromAddress(to) {
    if (!to) return null;
    const d = domain();
    const re = new RegExp(`${escapeRe(prefix())}([a-z0-9-]+)@([a-z0-9.-]+)`, 'gi');
    for (const m of String(to).matchAll(re)) {
        if (!d || m[2].toLowerCase() === d) return m[1].toLowerCase();
    }
    return null;
}

module.exports = { forwardingAddressFor, slugFromAddress };
