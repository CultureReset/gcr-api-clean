// ============================================================
// COMPANY LINKS — Paperclip company <-> business (CONTRACT top, §1)
// ============================================================
//
// The one reader and writer of company_links. A company is linked to exactly
// one business and a business to exactly one company; both are enforced by the
// table (primary key and unique), so a race between two links loses cleanly.

const supabase = require('../db');

const missingTable = (error) => /company_links/.test(error?.message || '') && /(does not exist|schema cache)/i.test(error.message);

async function slugForCompany(companyId) {
    if (!companyId) return null;
    const { data, error } = await supabase
        .from('company_links')
        .select('entity_slug')
        .eq('company_id', String(companyId))
        .maybeSingle();
    if (error) {
        if (missingTable(error)) return null;
        throw new Error(error.message);
    }
    return data?.entity_slug || null;
}

async function companyForSlug(slug) {
    if (!slug) return null;
    const { data, error } = await supabase
        .from('company_links')
        .select('company_id')
        .eq('entity_slug', slug)
        .maybeSingle();
    if (error) {
        if (missingTable(error)) return null;
        throw new Error(error.message);
    }
    return data?.company_id || null;
}

/**
 * Link a company to a business.
 *
 * Idempotent for the same pair. Refuses (err.status 409) when either side is
 * already linked to something else.
 */
async function linkCompany({ companyId, slug, linkedBy = null }) {
    if (!companyId || !slug) throw Object.assign(new Error('companyId and slug are required.'), { status: 400 });

    const current = await slugForCompany(companyId);
    if (current === slug) return { companyId: String(companyId), entitySlug: slug, created: false };
    if (current) throw Object.assign(new Error('This company is already linked to another business.'), { status: 409 });

    const holder = await companyForSlug(slug);
    if (holder && holder !== String(companyId)) {
        throw Object.assign(new Error('That business is already linked to another company.'), { status: 409 });
    }

    const { error } = await supabase
        .from('company_links')
        .insert({ company_id: String(companyId), entity_slug: slug, linked_by: linkedBy });
    if (error) {
        if (/duplicate|unique/i.test(error.message || '')) {
            // Lost a race. Report what is now true rather than guessing.
            const now = await slugForCompany(companyId);
            if (now === slug) return { companyId: String(companyId), entitySlug: slug, created: false };
            throw Object.assign(new Error('That business or company was linked by someone else just now.'), { status: 409 });
        }
        throw new Error(error.message);
    }
    return { companyId: String(companyId), entitySlug: slug, created: true };
}

async function unlinkCompany(companyId) {
    const { data, error } = await supabase
        .from('company_links')
        .delete()
        .eq('company_id', String(companyId))
        .select('entity_slug');
    if (error) throw new Error(error.message);
    return data?.[0]?.entity_slug || null;
}

module.exports = { slugForCompany, companyForSlug, linkCompany, unlinkCompany };
