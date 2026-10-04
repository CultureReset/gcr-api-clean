// ============================================================
// SECRET BOX — encrypt a small secret at rest (AES-256-GCM)
// ============================================================
//
// For secrets gcr-api-clean must hand back later, like an automation
// install's routine webhook secret (the "give to agent" step signs with it)
// and a business's Google OAuth tokens (lib/googleBusinessApi.js). The one
// place this API encrypts anything at rest.
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

/** Was this value made by seal()? */
const isSealed = (value) => typeof value === 'string' && value.startsWith(`${VERSION}.`);

function open(sealed, purpose = 'nextgent') {
    if (!sealed) return null;
    const [version, iv, tag, enc] = String(sealed).split('.');
    // enc may be '' — seal('') is a valid sealed empty string.
    if (version !== VERSION || !iv || !tag || enc === undefined) throw new Error('Not a sealed value.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(purpose), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Read a value stored before seal() existed: "ivHex:tagHex:encHex",
 * AES-256-GCM under a 32-byte hex key (the Google token format, key from
 * OAUTH_TOKEN_ENCRYPTION_KEY). Read-only: nothing new is written this way.
 */
function openLegacyHex(stored, hexKey) {
    if (!hexKey) throw new Error('No key for a value stored in the old format.');
    const [ivHex, tagHex, encHex] = String(stored).split(':');
    if (!ivHex || !tagHex || encHex === undefined) throw new Error('Not a stored value.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

/** The derived key itself, for a purpose that signs rather than encrypts (install session tokens). */
const derivedKey = (purpose) => key(purpose);

module.exports = { seal, open, isSealed, openLegacyHex, derivedKey };
