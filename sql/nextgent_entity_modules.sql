-- ============================================================
-- NEXT GENT — installed apps live in entity_modules (Step 3 contract, §B)
-- ============================================================
--
-- Paperclip is the authority for what is installed, at which version and
-- whether it is enabled. gcr-api-clean keeps one entity_modules row per app
-- install so the public page and the app's own screens render without calling
-- Paperclip per visit. entity_modules is a pre-existing live table (no DDL
-- here); these columns are added to it:
--
--   managed_by    'paperclip' for Paperclip's rows; null for the owner's and
--                 the legacy dashboard's (routes/platform.js never touches a
--                 paperclip row)
--   install_id    Paperclip store_installs.id — one row per install
--   company_id    the Paperclip company
--   version       the installed version
--   render_mode   how the public page draws it: inline | button | page | action
--   public_label  the owner's label for it on the public page
--   updated_at
--
-- The rest of the install is in the columns the table already has:
--   module_key = the app key, enabled, sort_order = position,
--   settings.manifest = the engine manifest (Paperclip's payload.app),
--   settings.config = the app's settings (secrets sealed by lib/secretBox.js),
--   settings.showOnPublic = the one public flag.
--
-- Written by lib/appInstances.js (routes/nextgent.js, routes/owner.js); read by
-- routes/app-data.js, routes/gcr.js and routes/platform.js. Supersedes
-- business_app_instances (sql/nextgent_apps.sql, which keeps app_records).
--
-- Additive only. Safe to re-run.

alter table public.entity_modules
  add column if not exists managed_by   text,
  add column if not exists install_id   text unique,
  add column if not exists company_id   text,
  add column if not exists version      text,
  add column if not exists render_mode  text check (render_mode in ('inline', 'button', 'page', 'action')) default 'inline',
  add column if not exists public_label text,
  add column if not exists updated_at   timestamptz default now();

create index if not exists entity_modules_install_id_idx on public.entity_modules (install_id);

notify pgrst, 'reload schema';
