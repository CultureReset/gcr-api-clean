-- ============================================================
-- NEXT GENT — a claim's code lives with every other phone code
-- ============================================================
--
-- routes/claims.js used to hash and check its own codes in
-- claim_codes.code_hash. Codes are now lib/phoneVerification.js's, stored in
-- phone_verification_codes with purpose `claim:<claim id>` (one copy of
-- digits, lifetime, tries and the secret: VERIFY_*). claim_codes stays the
-- claim record (company, listing, phone, channel, expiry, verified_at); new
-- rows carry no code_hash, so the column may be empty. Old rows keep theirs.
--
-- Needs sql/nextgent_claims.sql and sql/nextgent_phone.sql. Apply before
-- deploying the code that stops writing code_hash. Additive, safe to re-run.

alter table public.claim_codes alter column code_hash drop not null;

notify pgrst, 'reload schema';
