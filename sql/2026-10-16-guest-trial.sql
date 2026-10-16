-- Guest trial for the concierge (gcr-api-clean lib/guestUsage.js, tourist.js /ai-chat guest path).
-- Additive only. Run once in the Supabase SQL editor.

-- 1) Per-guest trial clock, keyed by the client's gcr_guest_id.
create table if not exists tourist_guest_usage (
  guest_id    uuid primary key,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  used_ms     bigint      not null default 0,
  chat_count  integer     not null default 0,
  merged_into uuid
);
alter table tourist_guest_usage enable row level security;
drop policy if exists "Service full access" on tourist_guest_usage;
create policy "Service full access" on tourist_guest_usage for all using (auth.role() = 'service_role');

-- 2) Guest-owned concierge conversations: guest_id set, user_id null until sign-in merge.
alter table tourist_ai_conversations add column if not exists guest_id uuid;
alter table tourist_ai_conversations alter column user_id drop not null;
create index if not exists idx_tourist_ai_conversations_guest on tourist_ai_conversations(guest_id) where guest_id is not null;
