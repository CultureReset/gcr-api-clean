-- ============================================================
-- NEXT GENT — computers: what the registry was last told (DECISIONS #73)
-- ============================================================
--
-- ghost_nodes.registry_state      the status last pushed to Paperclip's device
--                                 registry: { version, capabilities, phones }
--                                 (lib/deviceSync.js), so the next heartbeat
--                                 knows whether anything changed
-- ghost_nodes.registry_synced_at  when it was pushed, for the throttled
--                                 last-seen push (DEVICE_STATUS_PUSH_SECONDS)
--
-- Needs sql/ghost_nodes.sql. Additive only. Safe to re-run. Until applied
-- nothing is pushed and heartbeats are unaffected.

alter table public.ghost_nodes add column if not exists registry_state     jsonb;
alter table public.ghost_nodes add column if not exists registry_synced_at timestamptz;

notify pgrst, 'reload schema';
