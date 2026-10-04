// ============================================================
// EXPORT — everything one business has, as one JSON file (plan §6 teardown)
// ============================================================
//
// Offered to the owner before a business leaves. Every slug-scoped table the
// business has rows in (the same live list the dashboard reads, so a table
// added tomorrow is exported tomorrow) plus its entity row, uploaded to the
// storage bucket EXPORT_BUCKET and handed back as a signed link that expires
// after EXPORT_URL_TTL_SECONDS.

const supabase = require('../db');
const { getSchema } = require('./businessTables');

const PAGE = 1000;

async function allRows(table, slug) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from(table).select('*').eq('entity_slug', slug).range(from, from + PAGE - 1);
        if (error) return { rows, error: error.message };
        rows.push(...(data || []));
        if (!data || data.length < PAGE) return { rows };
    }
}

async function collect(slug) {
    const { tables } = await getSchema();
    const { data: entity } = await supabase.from('entity').select('*').eq('slug', slug).maybeSingle();
    const sections = {};
    const errors = {};
    for (const table of tables) {
        const { rows, error } = await allRows(table, slug);
        if (rows.length) sections[table] = rows;
        if (error) errors[table] = error;
    }
    return { exported_at: new Date().toISOString(), entity_slug: slug, entity, sections, errors };
}

/** Build, upload and sign the export. Resolves to { url, path, expiresAt }. */
async function exportBusiness(slug) {
    const bucket = process.env.EXPORT_BUCKET;
    if (!bucket) throw Object.assign(new Error('EXPORT_BUCKET is not set, so there is nowhere to put the export.'), { status: 503 });
    const ttl = Number(process.env.EXPORT_URL_TTL_SECONDS);
    if (!Number.isFinite(ttl) || ttl <= 0) throw Object.assign(new Error('EXPORT_URL_TTL_SECONDS must be set to a number of seconds.'), { status: 503 });

    const body = Buffer.from(JSON.stringify(await collect(slug), null, 2));
    const path = `${slug}/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const up = await supabase.storage.from(bucket).upload(path, body, { contentType: 'application/json', upsert: false });
    if (up.error) throw new Error(`Export upload failed: ${up.error.message}`);
    const signed = await supabase.storage.from(bucket).createSignedUrl(path, ttl);
    if (signed.error) throw new Error(`Export link failed: ${signed.error.message}`);
    return { url: signed.data.signedUrl, path, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
}

module.exports = { exportBusiness, collect };
