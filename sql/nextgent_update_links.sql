-- ============================================================
-- NEXT GENT — update_links.passcode_attempts
-- ============================================================
--
-- The daily update link (routes/update-link.js) is protected by a passcode.
-- A wrong guess is counted here, and after UPDATE_LINK_PASSCODE_ATTEMPTS
-- (default 5) the link is refused until a new one is minted. Without the
-- column the passcode check still holds; only the guess count is lost.
--
-- Additive only. Safe to re-run.

alter table public.update_links
    add column if not exists passcode_attempts integer not null default 0;

notify pgrst, 'reload schema';
