// ============================================================
// REQUIRED SECRETS — one secret per purpose, all present in production
// ============================================================
//
// Each of these signs or encrypts one kind of thing and nothing else, so the
// holder of one cannot forge or read another:
//
//   NEXTGENT_SERVICE_SECRET   service calls with Paperclip (lib/serviceSigning.js)
//   NEXTGENT_SECRETS_KEY      secrets stored at rest (lib/secretBox.js)
//   NEXTGENT_SESSION_SECRET   install session tokens (lib/businessTokens.js)
//   VERIFY_CODE_SECRET        phone codes (lib/phoneVerification.js)
//
// None is derived from another and none has a fallback. A production deploy
// (NODE_ENV or VERCEL_ENV = production) refuses to start with any missing,
// rather than running with a door it believes is locked. Elsewhere each
// library answers 503 for its own missing secret when it is first needed.

const REQUIRED_IN_PRODUCTION = Object.freeze([
    'NEXTGENT_SERVICE_SECRET',
    'NEXTGENT_SECRETS_KEY',
    'NEXTGENT_SESSION_SECRET',
    'VERIFY_CODE_SECRET',
]);

const isProduction = (env) => env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';

/** Throws, naming every missing secret, when this is production and one is unset. */
function assertSecrets(env = process.env) {
    if (!isProduction(env)) return;
    const missing = REQUIRED_IN_PRODUCTION.filter((name) => !String(env[name] || '').trim());
    if (missing.length) {
        throw new Error(`Refusing to start in production without ${missing.join(', ')} (see .env.example).`);
    }
}

module.exports = { REQUIRED_IN_PRODUCTION, assertSecrets };
