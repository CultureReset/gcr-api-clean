// DRAFT. Contract §3 v2 signing, byte-compatible with paperclip-ng services/nextgent-service-signing.ts.
const crypto = require('crypto');

const H = { ts: 'x-nextgent-timestamp', nonce: 'x-nextgent-nonce', sig: 'x-nextgent-signature' };
const MAX_AGE = 300;

const sha256Hex = (b) => crypto.createHash('sha256').update(b || '').digest('hex');

function signingString(ts, nonce, { method, pathname, query = '', rawBody = '' }) {
  return [ts, nonce, method.toUpperCase(), pathname, query, sha256Hex(rawBody)].join('\n');
}

/** Headers for an outbound signed request (gcr-api-clean → Paperclip). */
function signRequest(secret, { method, url, rawBody = '' }) {
  const u = new URL(url);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', secret)
    .update(signingString(ts, nonce, { method, pathname: u.pathname, query: u.search.replace(/^\?/, ''), rawBody }))
    .digest('hex');
  return { [H.ts]: ts, [H.nonce]: nonce, [H.sig]: sig };
}

const seen = new Map(); // nonce → expiry (per instance; use a table for multi-instance)
/** Express middleware for inbound signed requests (needs req.rawBody). */
function requireSignature(secret = process.env.NEXTGENT_SERVICE_SECRET) {
  return (req, res, next) => {
    if (!secret) return res.status(503).json({ error: 'NEXTGENT_SERVICE_SECRET is not set' });
    const ts = req.get(H.ts), nonce = req.get(H.nonce), sig = req.get(H.sig);
    if (!ts || !nonce || !sig) return res.status(401).json({ error: 'missing signature' });
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(ts)) > MAX_AGE) return res.status(401).json({ error: 'stale' });
    if (seen.has(nonce)) return res.status(401).json({ error: 'replay' });
    const [pathname, query = ''] = req.originalUrl.split('?');
    const want = crypto.createHmac('sha256', secret)
      .update(signingString(ts, nonce, { method: req.method, pathname, query, rawBody: req.rawBody || '' }))
      .digest('hex');
    const a = Buffer.from(want, 'hex'), b = Buffer.from(sig, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'bad signature' });
    seen.set(nonce, now + MAX_AGE);
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    next();
  };
}

module.exports = { signRequest, requireSignature, signingString, HEADERS: H };
