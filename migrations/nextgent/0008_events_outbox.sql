-- DRAFT. NOT RUN. Change-event bus. Written in the same transaction as the data change.
create table if not exists ng.events_outbox (
  id            bigserial primary key,
  event_id      uuid not null default gen_random_uuid() unique,
  business_id   uuid references ng.business(id) on delete cascade,
  module_id     text not null,                  -- menus, bookings, …
  type          text not null,                  -- menus.item.updated
  entity_table  text,
  entity_id     uuid,
  payload       jsonb not null default '{}',    -- {before, after, changed:[…]} or a summary
  actor         jsonb not null default '{}',    -- {kind:"agent"|"user"|"system", id, paperclip_task_id}
  created_at    timestamptz not null default now()
);
create index if not exists ng_outbox_biz_time on ng.events_outbox (business_id, created_at desc);
create index if not exists ng_outbox_type on ng.events_outbox (type);

create table if not exists ng.event_delivery (
  outbox_id     bigint not null references ng.events_outbox(id) on delete cascade,
  consumer      text not null,                  -- module:qr, automation:<id>, paperclip, connector:google_business
  status        text not null default 'pending',-- pending, delivered, failed, skipped
  attempts      int not null default 0,
  last_error    text,
  next_attempt_at timestamptz not null default now(),
  delivered_at  timestamptz,
  primary key (outbox_id, consumer)
);
create index if not exists ng_delivery_due on ng.event_delivery (status, next_attempt_at);

-- Notify listeners (worker can LISTEN ng_events instead of polling).
create or replace function ng.notify_event() returns trigger language plpgsql as $$
begin
  perform pg_notify('ng_events', json_build_object('id', new.id, 'type', new.type, 'business_id', new.business_id)::text);
  return new;
end $$;
drop trigger if exists ng_events_notify on ng.events_outbox;
create trigger ng_events_notify after insert on ng.events_outbox for each row execute function ng.notify_event();
