-- ============================================================
-- NEXT GENT — the people a business hears from and keeps (DECISIONS #44, #49)
-- ============================================================
--
-- Two business facts that apps used to keep as their own records
-- (enquiry forms in app_records; a `leads` dataKey in the generic section
-- store), now one table each, keyed by the business:
--
--   entity_leads       an enquiry: who asked, how to reach them, what they
--                      said, where it came from (`source`: the app key, a
--                      form, an import) and where it stands (`status`).
--                      Contract `leads.items` (lib/dataContracts.js).
--   entity_customers   the business's own customer record (customer_id is
--                      per business, DECISIONS #49; platform-wide identity is
--                      deferred and the 2026-07-19 canonical-gaps migration is
--                      NOT applied). One row per (business, phone) when a phone
--                      is known. Contract `customers.items`.
--
-- Both carry the provenance columns of SPEC §6.6, so a re-sync from an outside
-- system updates the row it made rather than duplicating it, and never
-- overwrites what the owner corrected (owner_override):
--
--   source_type         where the row came from (an app key, 'import', 'owner', 'sync:<provider>' …)
--   source_id           that source's own id for the record (an install id, a file)
--   external_record_id  the record's id in the outside system
--   source_updated_at   when the outside system last changed it
--   last_synced_at      when it was last compared with the outside system
--   created_by / updated_by
--   owner_override      true once the owner edited it by hand: a sync must not overwrite
--
-- The platform's own sales leads (`leads`, `business_leads`) are unrelated and
-- untouched. These two carry entity_slug, so they are business sections; the
-- raw table names are held private by lib/businessTables.js (a lead is a
-- record of a person) and are reached through their contracts, which the
-- registry opens to the permissioned door only — never the public one.
--
-- Additive only. Safe to re-run.

create table if not exists public.entity_leads (
    id                  uuid primary key default gen_random_uuid(),
    entity_slug         text not null,
    name                text,
    email               text,
    phone               text,
    message             text,
    source              text,
    status              text not null default 'new',
    source_type         text,
    source_id           text,
    external_record_id  text,
    source_updated_at   timestamptz,
    last_synced_at      timestamptz,
    created_by          text,
    updated_by          text,
    owner_override      boolean not null default false,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists entity_leads_slug_idx on public.entity_leads (entity_slug, created_at desc);
create index if not exists entity_leads_source_idx on public.entity_leads (entity_slug, source_type, external_record_id);

create table if not exists public.entity_customers (
    id                  uuid primary key default gen_random_uuid(),
    entity_slug         text not null,
    name                text,
    phone               text,
    email               text,
    notes               text,
    source_type         text,
    source_id           text,
    external_record_id  text,
    source_updated_at   timestamptz,
    last_synced_at      timestamptz,
    created_by          text,
    updated_by          text,
    owner_override      boolean not null default false,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists entity_customers_slug_idx on public.entity_customers (entity_slug, created_at desc);
create index if not exists entity_customers_source_idx on public.entity_customers (entity_slug, source_type, external_record_id);
-- One customer per phone per business, when a phone is known.
create unique index if not exists entity_customers_slug_phone_key on public.entity_customers (entity_slug, phone) where phone is not null;

alter table public.entity_leads     enable row level security;
alter table public.entity_customers enable row level security;
revoke all on public.entity_leads     from anon, authenticated;
revoke all on public.entity_customers from anon, authenticated;

notify pgrst, 'reload schema';
