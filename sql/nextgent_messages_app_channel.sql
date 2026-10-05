-- ============================================================
-- NEXT GENT — an app's submission lands in the one Messages inbox (DECISIONS #48)
-- ============================================================
--
-- Every app-owned table a visitor may append to (manifest data.tables.<t>.public
-- = 'append') is a submission to the business: an enquiry, a song request, a
-- shout-out. routes/app-data.js records each one as an inbound business_messages
-- row on a message_threads thread, so it shows in Messages beside the texts
-- and emails — channel 'app', install_id = the install it came through, the
-- customer's email or phone as the address (else the record's first text).
--
-- The two channel checks only knew email | sms | voice. This widens each by
-- 'app'. Dropping a check constraint touches no rows and no columns; it is
-- re-added with the extra value in the same statement run. Which app a row came
-- from is read from install_id (lib/messages.js), so no column is added.
--
-- Needs nextgent_messages.sql. Additive only. Safe to re-run.

alter table public.message_threads
    drop constraint if exists message_threads_channel_check;
alter table public.message_threads
    add constraint message_threads_channel_check check (channel in ('email', 'sms', 'voice', 'app'));

alter table public.business_messages
    drop constraint if exists business_messages_channel_check;
alter table public.business_messages
    add constraint business_messages_channel_check check (channel in ('email', 'sms', 'voice', 'app'));

notify pgrst, 'reload schema';
