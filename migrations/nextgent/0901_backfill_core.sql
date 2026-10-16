-- DRAFT. NOT RUN. Backfill from public.* (idempotent). Column names below follow routes/*.js usage
-- and MUST be checked against a dump of the live schema before running.
insert into ng.business (id, slug, name, kind)
select e.id, e.slug, e.name, coalesce(e.entity_subtype, e.entity_type)
from public.entity e on conflict (id) do nothing;

-- owners → members (accounts created by the auth backfill script, not SQL)
-- insert into ng.business_member … from public.entity_owners …

-- hours
insert into ng.hours (business_id, kind, weekday, opens, closes, closed)
select b.id, 'regular', h.day_of_week, h.open_time, h.close_time, coalesce(h.is_closed,false)
from public.entity_hours h join ng.business b on b.slug = h.entity_slug
on conflict do nothing;

-- menus: one ng.menu per (business, kind), sections and items keep their ids
insert into ng.menu (id, business_id, kind, name)
select gen_random_uuid(), b.id, 'food', 'Menu' from ng.business b
where exists (select 1 from public.menu_sections s where s.entity_slug = b.slug)
on conflict do nothing;
insert into ng.menu_section (id, business_id, menu_id, name, description, sort_order)
select s.id, b.id, m.id, s.section_name, s.section_description, coalesce(s.sort_order,0)
from public.menu_sections s join ng.business b on b.slug = s.entity_slug
join ng.menu m on m.business_id = b.id and m.kind = 'food'
on conflict (id) do nothing;
insert into ng.menu_item (id, business_id, section_id, name, description, price_cents, is_available, sort_order)
select i.id, s.business_id, i.section_id, i.item_name, i.description,
       case when i.price ~ '^\$?[0-9]+(\.[0-9]{1,2})?$' then (replace(i.price,'$','')::numeric*100)::int end,
       coalesce(i.is_available,true), coalesce(i.sort_order,0)
from public.menu_items i join ng.menu_section s on s.id = i.section_id
on conflict (id) do nothing;
-- drinks / happy hour: same pattern into ng.menu kind 'drinks' / 'happy_hour' (see DATA-MODEL.md §4)
-- specials: public.entity_specials → ng.special ; events: public.entity_events → ng.event
-- legacy site_id menus (public.menu_items.site_id + menu_categories): map businesses.id → entity via
--   businesses.gcr_entity_id / slug, then insert as above (open question Q3)
