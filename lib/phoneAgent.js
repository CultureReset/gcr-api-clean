// ============================================================
// PHONE AGENT — a business's own number, bought when the agent is installed
// ============================================================
//
// Plan §12: installing the Phone Agent buys the business its own number,
// starts its texting registration, adds its monthly cost to the bill, and
// shows the owner how to forward their line. Which store item is a Phone
// Agent is decided by the install itself, never by its name:
//
//   - the install payload asks for the `telephony` capability
//     (capabilities: ['telephony', …] or a telephony: { … } block), or
//   - its item is PHONE_AGENT_NUMBER_ITEM_KEY.
//
// The number goes through lib/telephony (buyNumber attaches the voice
// connection and messaging profile from env). Its texting registration
// (US A2P 10DLC) is an outside process: the row starts not_started and only a
// signed update (PUT /api/nextgent/numbers/:phone/registration) moves it.
// Nothing here pretends it is approved.
//
// Forwarding instructions are data: forwarding_codes rows hold each
// network's dial codes with {e164} / {national} where the number goes.

const supabase = require('../db');
const telephony = require('./telephony');
const billingStripe = require('./billingStripe');
const { envStr } = require('./env');

const REGISTRATION = new Set(['not_started', 'pending', 'approved', 'rejected']);

/** Does this install want a phone number? */
function wantsNumber(payload, itemKey) {
    const caps = Array.isArray(payload?.capabilities) ? payload.capabilities.map(String) : [];
    if (caps.includes('telephony')) return true;
    if (payload?.telephony && typeof payload.telephony === 'object') return true;
    const key = envStr('PHONE_AGENT_NUMBER_ITEM_KEY');
    return !!key && key === itemKey;
}

/** The area code to look in: asked for, else the business's own (North American) number's. */
async function areaCodeFor(slug, payload) {
    const asked = String(payload?.telephony?.areaCode || '').replace(/\D/g, '');
    if (asked) return asked;
    const { data } = await supabase.from('entity').select('phone').eq('slug', slug).maybeSingle();
    const e164 = telephony.normalizePhone(data?.phone);
    const cc = String(process.env.TELEPHONY_DEFAULT_COUNTRY_CODE || '1').replace(/\D/g, '');
    return e164 && cc === '1' && e164.startsWith('+1') ? e164.slice(2, 5) : null;
}

function nationalOf(e164) {
    const cc = String(process.env.TELEPHONY_DEFAULT_COUNTRY_CODE || '1').replace(/\D/g, '');
    const digits = String(e164 || '').replace(/\D/g, '');
    return digits.startsWith(cc) ? digits.slice(cc.length) : digits;
}

/** Forwarding instructions for a number, from the forwarding_codes rows. */
async function forwardingFor(phoneNumber) {
    const { data, error } = await supabase.from('forwarding_codes').select('*').order('sort_order', { ascending: true });
    if (error) return [];
    const fill = (t) => (t ? String(t).replace(/\{e164\}/g, phoneNumber).replace(/\{national\}/g, nationalOf(phoneNumber)) : null);
    return (data || []).map((r) => ({
        key: r.key, label: r.label, network: r.network || null, when: r.when_forwarded || null,
        enable: fill(r.enable_template), disable: fill(r.disable_template), note: r.note || null,
    }));
}

/**
 * Buy and record a number for an install. Resolves the row. The caller
 * decides about the bill (chargeNumber) once the install is recorded.
 */
async function provisionNumber({ slug, companyId, installId, payload }) {
    const areaCode = await areaCodeFor(slug, payload);
    const bought = await telephony.buyNumber({ areaCode: areaCode || undefined, countryCode: payload?.telephony?.countryCode || undefined });
    const phone = telephony.normalizePhone(bought.phoneNumber);
    const { data, error } = await supabase.from('business_phone_numbers').insert({
        entity_slug: slug,
        company_id: companyId ? String(companyId) : null,
        install_id: installId,
        phone_number: phone,
        provider: bought.provider,
        provider_ref: bought.orderId || null,
        purpose: 'phone_agent',
        status: 'active',
        registration_status: 'not_started',
    }).select('*').single();
    if (error) {
        // Recorded nowhere means billed nowhere: give the number back.
        await telephony.releaseNumber({ phoneNumber: phone }).catch(() => {});
        throw Object.assign(new Error(`The number could not be recorded: ${error.message}`), { status: 503 });
    }
    return data;
}

/** Add the number's monthly charge, unless the install itself already bills that item. */
async function chargeNumber(row, { installCharged = false, itemKey } = {}) {
    if (installCharged && envStr('PHONE_AGENT_NUMBER_ITEM_KEY') === itemKey) return { charged: false, reason: 'billed_as_the_install' };
    const out = await billingStripe.chargePhoneNumber({ slug: row.entity_slug, companyId: row.company_id, phoneNumber: row.phone_number });
    await supabase.from('business_phone_numbers').update({ charged: !!out.charged }).eq('id', row.id);
    return out;
}

/** Release every number an install holds, and stop billing for them. */
async function releaseForInstall(installId) {
    const { data } = await supabase.from('business_phone_numbers').select('*').eq('install_id', installId).eq('status', 'active');
    const released = [];
    for (const row of data || []) {
        try {
            await telephony.releaseNumber({ phoneNumber: row.phone_number });
        } catch (e) {
            if (e.status !== 404) {
                await supabase.from('business_phone_numbers').update({ registration_note: `Release failed: ${e.message}`.slice(0, 300) }).eq('id', row.id);
                continue;
            }
        }
        await billingStripe.releasePhoneNumberCharge(row.phone_number).catch(() => {});
        await supabase.from('business_phone_numbers').update({ status: 'released', released_at: new Date().toISOString() }).eq('id', row.id);
        released.push(row.phone_number);
    }
    return released;
}

/** Record where the texting registration stands. Only the outside process calls this. */
async function setRegistration(phoneNumber, { status, ref = null, note = null }) {
    if (!REGISTRATION.has(status)) throw Object.assign(new Error(`status must be one of ${[...REGISTRATION].join(', ')}.`), { status: 400 });
    const phone = telephony.normalizePhone(phoneNumber);
    const { data, error } = await supabase.from('business_phone_numbers')
        .update({ registration_status: status, registration_ref: ref, registration_note: note, registration_updated_at: new Date().toISOString() })
        .eq('phone_number', phone).eq('status', 'active').select('*');
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    if (!data?.length) throw Object.assign(new Error('No active number like that.'), { status: 404 });
    return data[0];
}

/** Which install answers a number, if any: the active Phone Agent number row. */
async function numberRow(phoneNumber) {
    const phone = telephony.normalizePhone(phoneNumber);
    if (!phone) return null;
    const { data } = await supabase.from('business_phone_numbers').select('*').eq('phone_number', phone).eq('status', 'active').maybeSingle();
    return data || null;
}

module.exports = { wantsNumber, provisionNumber, chargeNumber, releaseForInstall, forwardingFor, setRegistration, numberRow, nationalOf };
