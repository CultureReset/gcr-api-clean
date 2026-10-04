// Reading tunables from the environment, one way everywhere.
//
// Every name read through here is documented in .env.example. A fallback keeps
// a missing variable from switching a feature off; it is not a substitute for
// configuring it.

/**
 * A whole number from env, or the fallback when it is unset, blank, not a
 * number or below `min` (default 1; pass { min: 0 } where 0 means "none",
 * e.g. no wait between JWKS refetches).
 */
function envInt(name, fallback, { min = 1 } = {}) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function envStr(name, fallback = null) {
    const v = process.env[name];
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function envBool(name, fallback = false) {
    const v = String(process.env[name] ?? '').trim().toLowerCase();
    if (!v) return fallback;
    return v === 'true' || v === '1' || v === 'yes';
}

/** A JSON value from env, or the fallback when it is absent or not JSON. */
function envJson(name, fallback = null) {
    const raw = process.env[name];
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch {
        console.warn(`[env] ${name} is not valid JSON; ignored.`);
        return fallback;
    }
}

/** A base URL without its trailing slash, or null. */
const envUrl = (name) => {
    const v = envStr(name);
    return v ? v.replace(/\/+$/, '') : null;
};

module.exports = { envInt, envStr, envBool, envJson, envUrl };
