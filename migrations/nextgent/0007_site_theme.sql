-- DRAFT. NOT RUN. Website builder, link page, theme (replaces site_content, site_pages, businesses theme cols).
create table if not exists ng.theme (
  business_id uuid primary key references ng.business(id) on delete cascade,
  tokens jsonb not null default '{}',           -- color/type/shape/layout/brand/motion tokens
  variants jsonb not null default '{}',         -- {"PublicMenu":"cards","LinkPage":"stack"}
  updated_at timestamptz not null default now());
create table if not exists ng.site (
  business_id uuid primary key references ng.business(id) on delete cascade,
  subdomain text unique, custom_domain text unique, domain_status text,
  published_at timestamptz, published_version int not null default 0);
create table if not exists ng.site_page (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  kind text not null default 'page',           -- home, page, link (link page), landing
  path text not null, title text, seo jsonb not null default '{}', sort_order int not null default 0,
  unique (business_id, path));
create table if not exists ng.site_block (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references ng.site_page(id) on delete cascade,
  module text not null, block text not null,   -- ("menus","MenuBlock"), ("core","Hero"), ("shop","ShopGrid")
  props jsonb not null default '{}', sort_order int not null default 0, visible boolean not null default true);
create table if not exists ng.site_revision (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references ng.business(id) on delete cascade,
  version int not null, snapshot jsonb not null, created_at timestamptz not null default now(), created_by uuid);
