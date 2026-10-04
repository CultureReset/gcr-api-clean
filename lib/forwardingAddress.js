// The address a business forwards its email to (plan §9, "How data comes in").
//
// The same mechanism routes/email-parser.js already reads: the TO address
// carries the slug as <prefix><slug>@<domain>, and /api/email-parser/inbound
// takes the slug back out of it. Domain and prefix are configuration:
//
//   INTAKE_EMAIL_DOMAIN   the inbound-parse domain (required for an address)
//   INTAKE_EMAIL_PREFIX   defaults to the prefix the parser's slugFromTo reads
//
// Without a domain there is no address, and callers say so rather than
// inventing one.

// The prefix routes/email-parser.js slugFromTo() matches; change both together.
const PARSER_PREFIX = 'gcr-';

function forwardingAddressFor(slug) {
    const domain = (process.env.INTAKE_EMAIL_DOMAIN || '').trim().replace(/^@/, '');
    if (!slug || !domain) return null;
    const prefix = process.env.INTAKE_EMAIL_PREFIX ?? PARSER_PREFIX;
    return `${prefix}${slug}@${domain}`;
}

module.exports = { forwardingAddressFor };
