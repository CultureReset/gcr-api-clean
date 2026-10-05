-- ============================================================
-- NEXT GENT — the business's currency is a business fact (DECISIONS #44)
-- ============================================================
--
-- QR Menu and Listings each kept a `config.currency` of their own, and the
-- owner app fell back to a build-time default. The currency a business prices
-- in is one fact about the business, so it lives on the business record and
-- every app reads it through the `business.currency` contract
-- (lib/dataContracts.js).
--
-- Nullable, with no default here: a null means "not set", and the API answers
-- with its DEFAULT_CURRENCY environment value (the same one
-- routes/email-webhook.js already uses) rather than this file deciding a
-- currency for every business. The owner sets it through PATCH
-- /api/owner/profile like any other editable column.
--
-- Additive only. Safe to re-run.

alter table public.entity
  add column if not exists currency text;

comment on column public.entity.currency is
  'ISO 4217 code the business prices in. Null = not set; the API falls back to DEFAULT_CURRENCY.';

notify pgrst, 'reload schema';
