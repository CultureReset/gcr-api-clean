// ============================================================
// SECRET BOX — encrypt a small secret at rest (AES-256-GCM)
// ============================================================
//
// For secrets gcr-api-clean must hand back later, like an automation
// install's routine webhook secret (the "give to agent" step signs with it).
// The key is derived (HKDF-SHA256) from NEXTGENT_SECRETS_KEY, or from
// NEXTGENT_SERVICE_SECRET when that is not set, so no extra key is required.
// Rotating the source secret makes stored values unreadable; reinstalling the
// automation stores a fresh one.

const crypto = require('crypto');

const VERSION = 'v1';

function key(purpose) {
    const source = process.env.NEXTGENT_SECRETS_KEY || process.env.NEXTGENT_SERVICE_SECRET;
    if (!source) throw Object.assign(new Error('NEXTGENT_SECRETS_KEY or NEXTGENT_SERVICE_SECRET is required to store secrets.'), { status: 503 });
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(source), Buffer.alloc(0), Buffer.from(purpose), 32));
}

function seal(plaintext, purpose = 'nextgent') {
    if (plaintext === null || plaintext === undefined) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(purpose), iv);
    const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

function open(sealed, purpose = 'nextgent') {
    if (!sealed) return null;
    const [version, iv, tag, enc] = String(sealed).split('.');
    if (version !== VERSION || !iv || !tag || !enc) throw new Error('Not a sealed value.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(purpose), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { seal, open };
