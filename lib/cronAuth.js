// ============================================================
// CRON AUTH — the one guard on every scheduled endpoint
// ============================================================
//
// Vercel's cron calls each endpoint in vercel.json with
// `Authorization: Bearer <CRON_SECRET>`; an operator's own scheduler may send
// `x-cron-secret` instead. Either header is accepted, nothing in the URL or
// the body is: a secret in a query string ends up in access logs.
//
// With CRON_SECRET unset every scheduled endpoint is closed (503, naming the
// variable) rather than open to anyone who finds the path.

const crypto = require('crypto');
const { envStr } = require('./env');

function presented(req) {
    const header = String(req.headers.authorization || '');
    if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
    return String(req.headers['x-cron-secret'] || '').trim();
}

/** Is this request carrying the configured CRON_SECRET in a header? */
function cronAllowed(req) {
    const secret = envStr('CRON_SECRET');
    if (!secret) return false;
    const given = Buffer.from(presented(req));
    const expected = Buffer.from(secret);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Express middleware for a scheduled endpoint. */
function cronRequired(req, res, next) {
    if (!envStr('CRON_SECRET')) return res.status(503).json({ error: 'CRON_SECRET is not set; scheduled endpoints are closed until it is.' });
    if (!cronAllowed(req)) return res.status(401).json({ error: 'Unauthorized' });
    return next();
}

module.exports = { cronAllowed, cronRequired };
