-- ============================================================
-- NEXT GENT — menu items have an order and an availability (DECISIONS #65)
-- ============================================================
--
-- schema.sql's menu_items has neither column, yet routes/platform.js has been
-- writing is_available and the QR Menu app orders its items. This makes both
-- real columns:
--
--   sort_order     the owner's order within a section (null = unordered; the
--                  menu.items contract reads sort_order, then id)
--   is_available   false hides an item without deleting it (default true)
--
-- Additive only. Safe to re-run.

alter table public.menu_items
  add column if not exists sort_order   integer,
  add column if not exists is_available boolean not null default true;

create index if not exists menu_items_slug_order_idx on public.menu_items (entity_slug, sort_order, id);

notify pgrst, 'reload schema';
