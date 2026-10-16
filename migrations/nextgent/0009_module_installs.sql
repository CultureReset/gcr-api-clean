-- DRAFT. NOT RUN. Module registry + installs (projection of Paperclip store installs; replaces site_apps,
-- module_manifest, user_modules, installed_modules, entity_modules).
create table if not exists ng.module (
  id text primary key, version text not null, kind text not null, manifest jsonb not null,
  updated_at timestamptz not null default now());
create table if not exists ng.module_install (
  business_id uuid not null references ng.business(id) on delete cascade,
  module_id text not null references ng.module(id),
  version text not null,
  status text not null default 'installed',     -- installed, disabled
  config jsonb not null default '{}',
  permissions text[] not null default '{}',
  paperclip_install_id text unique,
  installed_at timestamptz not null default now(),
  primary key (business_id, module_id));
