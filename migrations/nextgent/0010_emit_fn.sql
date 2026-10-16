-- DRAFT. NOT RUN. Atomic write+emit for modules that call SQL functions via supabase.rpc().
create or replace function ng.emit(p_business uuid, p_module text, p_type text, p_table text, p_id uuid, p_payload jsonb, p_actor jsonb)
returns bigint language sql as $$
  insert into ng.events_outbox (business_id, module_id, type, entity_table, entity_id, payload, actor)
  values (p_business, p_module, p_type, p_table, p_id, coalesce(p_payload,'{}'), coalesce(p_actor,'{}'))
  returning id;
$$;

-- Example: update a menu item and emit in one transaction.
create or replace function ng.menu_item_update(p_business uuid, p_id uuid, p_patch jsonb, p_actor jsonb)
returns ng.menu_item language plpgsql as $$
declare before ng.menu_item; after ng.menu_item;
begin
  select * into before from ng.menu_item where id = p_id and business_id = p_business for update;
  if not found then raise exception 'not found'; end if;
  update ng.menu_item set
    name = coalesce(p_patch->>'name', name),
    description = coalesce(p_patch->>'description', description),
    price_cents = coalesce((p_patch->>'price_cents')::int, price_cents),
    is_available = coalesce((p_patch->>'is_available')::boolean, is_available),
    updated_at = now()
  where id = p_id returning * into after;
  perform ng.emit(p_business, 'menus', 'menus.item.updated', 'ng.menu_item', p_id,
                  jsonb_build_object('before', to_jsonb(before), 'after', to_jsonb(after)), p_actor);
  return after;
end $$;
