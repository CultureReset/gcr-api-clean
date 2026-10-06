-- Execution ownership is independent of business records, billing and MCP tokens.
-- Existing automations remain intact. Moving one requires reconciling its settings
-- and pending runs/waits; this migration never disables or deletes customer work.
alter table public.nextgent_installs
    add column if not exists execution_owner text not null default 'gcr'
    check (execution_owner in ('gcr', 'paperclip'));

create index if not exists nextgent_native_automation_owner_idx
    on public.nextgent_installs (entity_slug, item_key)
    where kind = 'automation' and status = 'active' and execution_owner = 'paperclip';

create or replace function public.nextgent_guard_automation_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
    if new.kind <> 'automation' then return new; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.entity_slug || ':' || new.item_key, 0));
    if new.status = 'active' and new.execution_owner = 'paperclip' and (
        exists (select 1 from public.entity_automations ea join public.automations a on a.id = ea.automation_id
                where ea.entity_slug = new.entity_slug and a.key = new.item_key)
        or exists (select 1 from public.automation_runs r join public.automations a on a.id = r.automation_id
                   where r.entity_slug = new.entity_slug and a.key = new.item_key and r.status in ('running', 'waiting'))
        or exists (select 1 from public.automation_waits w join public.automations a on a.id = w.automation_id
                   where w.entity_slug = new.entity_slug and a.key = new.item_key and w.state in ('waiting', 'running'))
    ) then
        raise exception 'automation_handoff_required: reconcile legacy settings, runs and waits before Paperclip takeover' using errcode = '23514';
    end if;
    return new;
end;
$$;

create or replace function public.nextgent_guard_legacy_automation_owner()
returns trigger language plpgsql set search_path = '' as $$
declare legacy_item_key text;
begin
    select a.key into legacy_item_key from public.automations a where a.id = new.automation_id;
    if legacy_item_key is null then return new; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.entity_slug || ':' || legacy_item_key, 0));
    if exists (select 1 from public.nextgent_installs i where i.entity_slug = new.entity_slug
               and i.item_key = legacy_item_key and i.kind = 'automation' and i.status = 'active'
               and i.execution_owner = 'paperclip') then
        raise exception 'automation_owned_by_paperclip: use the Paperclip Store to manage this automation' using errcode = '23514';
    end if;
    return new;
end;
$$;

drop trigger if exists nextgent_automation_owner_guard on public.nextgent_installs;
create trigger nextgent_automation_owner_guard before insert or update on public.nextgent_installs
    for each row execute function public.nextgent_guard_automation_owner();
drop trigger if exists nextgent_legacy_automation_owner_guard on public.entity_automations;
create trigger nextgent_legacy_automation_owner_guard before insert or update on public.entity_automations
    for each row execute function public.nextgent_guard_legacy_automation_owner();

revoke all on function public.nextgent_guard_automation_owner() from public, anon, authenticated;
revoke all on function public.nextgent_guard_legacy_automation_owner() from public, anon, authenticated;
grant execute on function public.nextgent_guard_automation_owner() to service_role;
grant execute on function public.nextgent_guard_legacy_automation_owner() to service_role;
notify pgrst, 'reload schema';
