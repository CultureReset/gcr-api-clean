-- ============================================================
-- NEXT GENT — one consent record: message_consent
-- ============================================================
--
-- A customer's yes to texts used to be read from three places:
-- message_consent, booking_opt_ins.sms_consent (the GCR Reserve page and the
-- embed widget) and bookings.sms_consent (the older site booking form).
-- lib/messages.js hasSmsConsent is now the only check and reads
-- message_consent only; the forms record their yes there as they take it.
-- This copies the yeses already given into it.
--
--   * Phones are stored in E.164, as lib/telephony normalizePhone writes them:
--     "+digits" stays; a bare national number gets the default country code
--     below. Set it to the API's TELEPHONY_DEFAULT_COUNTRY_CODE before running
--     (it is that env value's fallback, the North American plan this database
--     has served). Numbers that do not normalise are skipped.
--   * A row already in message_consent wins (on conflict do nothing): a later
--     STOP, a revocation or a newer yes is never overwritten.
--   * A site booking's consent is recorded under the site's entity slug when
--     businesses links one, else under the site id — the same key
--     lib/messages.js businessKeyForSite() uses when those flows text.
--
-- booking_opt_ins and bookings are left as they are (booking_opt_ins is still
-- the Reserve page's proof that a name and phone were captured).
--
-- Needs sql/nextgent_messages.sql. Additive only. Safe to re-run.

with settings as (
    select '1'::text as default_country_code   -- = TELEPHONY_DEFAULT_COUNTRY_CODE
),
raw as (
    select o.entity_slug as business_key,
           o.phone as raw_phone,
           coalesce(o.consent_text, 'booking opt-in') as consent_text,
           'booking_opt_in'::text as source,
           o.created_at as given_at
    from public.booking_opt_ins o
    where o.sms_consent is true and o.entity_slug is not null and o.phone is not null
    union all
    select coalesce(b.entity_slug, bk.site_id::text),
           bk.customer_phone,
           coalesce(bk.sms_consent_text, 'booking form'),
           'site_booking',
           coalesce(bk.sms_consent_at, bk.created_at)
    from public.bookings bk
    left join public.businesses b on b.id = bk.site_id
    where bk.sms_consent is true and bk.site_id is not null and bk.customer_phone is not null
),
normalised as (
    select r.business_key,
           case
               when btrim(r.raw_phone) like '+%'
                    and length(regexp_replace(r.raw_phone, '\D', '', 'g')) between 8 and 15
                   then '+' || regexp_replace(r.raw_phone, '\D', '', 'g')
               when s.default_country_code = '1'
                    and length(regexp_replace(r.raw_phone, '\D', '', 'g')) = 10
                   then '+1' || regexp_replace(r.raw_phone, '\D', '', 'g')
               when s.default_country_code = '1'
                    and length(regexp_replace(r.raw_phone, '\D', '', 'g')) = 11
                    and left(regexp_replace(r.raw_phone, '\D', '', 'g'), 1) = '1'
                   then '+' || regexp_replace(r.raw_phone, '\D', '', 'g')
               when s.default_country_code <> '1'
                    and length(regexp_replace(r.raw_phone, '\D', '', 'g')) >= 6
                   then '+' || s.default_country_code || regexp_replace(r.raw_phone, '\D', '', 'g')
               else null
           end as phone,
           r.consent_text,
           r.source,
           r.given_at
    from raw r cross join settings s
),
latest as (
    select distinct on (business_key, phone)
           business_key, phone, consent_text, source, given_at
    from normalised
    where phone is not null
    order by business_key, phone, given_at desc nulls last
)
insert into public.message_consent (entity_slug, channel, phone, status, source, consent_text, recorded_by, recorded_at)
select business_key, 'sms', phone, 'granted', source, consent_text, 'sql/nextgent_consent_fold.sql', coalesce(given_at, now())
from latest
on conflict (entity_slug, channel, phone) do nothing;

notify pgrst, 'reload schema';
