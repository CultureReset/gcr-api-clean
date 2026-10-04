// Phone number helpers shared by every telephony provider.

/**
 * Normalise to E.164, or null when it cannot be.
 *
 * A number already in +E.164 is kept. A bare national number is given the
 * default country code (TELEPHONY_DEFAULT_COUNTRY_CODE, digits only), which is
 * what utils/sms.js always assumed.
 */
function normalizePhone(phone, countryCode = process.env.TELEPHONY_DEFAULT_COUNTRY_CODE || '1') {
    if (!phone) return null;
    const raw = String(phone).trim();
    const digits = raw.replace(/\D/g, '');
    if (!digits) return null;
    if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
    const cc = String(countryCode).replace(/\D/g, '');
    // The national number length below is the North American one, the only
    // plan this API has ever served; other countries arrive as +E.164.
    if (cc === '1') {
        if (digits.length === 10) return `+1${digits}`;
        if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
        return null;
    }
    if (digits.startsWith(cc) && digits.length > cc.length + 6) return `+${digits}`;
    return digits.length >= 6 ? `+${cc}${digits}` : null;
}

/** Last four digits, for telling a person which phone a code went to. */
const phoneHint = (e164) => (e164 ? String(e164).slice(-4) : null);

module.exports = { normalizePhone, phoneHint };
