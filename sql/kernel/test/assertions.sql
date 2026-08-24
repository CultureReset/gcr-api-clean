-- ============================================================================
-- What the kernel migrations must be true after applying. Run by
-- scripts/test-kernel-sql.sh against a throwaway database, never production.
-- ============================================================================
--
-- These are not "did the DDL parse" checks — that already passed by the time
-- this file runs. Each one is a property the design depends on, written so
-- that removing the safeguard makes a test fail rather than making a comment
-- become untrue quietly.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 002 · the registry fails closed ─────────────────────────────────────────
do $$
begin
  assert (select count(*) from public.table_registry) > 0,
    'table_registry was not seeded from information_schema';

  assert (select count(*) from public.table_registry
          where classification <> 'UNCLASSIFIED') = 0,
    'discovery classified a table on its own. Seeding must never decide.';

  assert (select count(*) from public.table_registry
          where is_business_section) = 0,
    'a table became a dashboard section without anyone reviewing it';

  assert (select tenant_column from public.table_registry
          where table_name = 'entity_modules') = 'entity_slug',
    'tenant column detection missed entity_slug on entity_modules';

  assert (select tenant_column from public.table_registry
          where table_name = 'module_catalog') is null,
    'a global catalog was detected as business-scoped';

  assert exists (select 1 from public.table_registry_gaps
                 where table_name = 'entity_modules'),
    'the gaps view does not list an unclassified business-scoped table';
end
$$;

-- A classification without a reviewer must be refused.
do $$
begin
  begin
    update public.table_registry
       set classification = 'DATA_MODULE'
     where table_name = 'entity_modules';
    raise exception 'ASSERTION FAILED: a table was classified with no reviewer';
  exception when check_violation then
    null;  -- expected
  end;
end
$$;

-- With a reviewer, it goes through, and the gaps view stops listing it.
update public.table_registry
   set classification = 'DATA_MODULE',
       visibility_class = 'BUSINESS_PRIVATE',
       is_business_section = true,
       reviewed_by = gen_random_uuid(),
       reviewed_at = now()
 where table_name = 'entity_modules';

do $$
begin
  assert not exists (select 1 from public.table_registry_gaps
                     where table_name = 'entity_modules'),
    'a reviewed table is still showing as a gap';
end
$$;

-- ── 001 · one primary, and no self-parenting ────────────────────────────────
do $$
declare
  ws uuid;
begin
  insert into public.workspaces (name, owner_user_id)
  values ('Crab Holdings', gen_random_uuid()) returning id into ws;

  insert into public.workspace_entities (workspace_id, entity_slug, is_primary)
  values (ws, 'the-blue-crab', true);

  begin
    insert into public.workspace_entities (workspace_id, entity_slug, is_primary)
    values (ws, 'dockside-bar', true);
    raise exception 'ASSERTION FAILED: a workspace took a second primary business';
  exception when unique_violation then
    null;  -- expected
  end;

  insert into public.workspace_entities (workspace_id, entity_slug, is_primary)
  values (ws, 'dockside-bar', false);

  assert (select count(*) from public.workspace_entities where workspace_id = ws) = 2,
    'workspace_entities did not accept a second non-primary business';
end
$$;

do $$
begin
  begin
    update public.entity set parent_entity_slug = 'the-blue-crab'
     where slug = 'the-blue-crab';
    raise exception 'ASSERTION FAILED: a business became its own parent';
  exception when check_violation then
    null;  -- expected
  end;

  begin
    update public.entity set parent_entity_slug = 'no-such-business'
     where slug = 'dockside-bar';
    raise exception 'ASSERTION FAILED: a parent slug naming no business was accepted';
  exception when foreign_key_violation then
    null;  -- expected
  end;
end
$$;

-- Roles seeded, and every seeded role is marked as one this platform depends on.
do $$
begin
  assert (select count(*) from public.roles where is_system) >= 7,
    'the system roles were not seeded';
end
$$;

-- ── 003 · capability keys must be dotted ────────────────────────────────────
do $$
begin
  assert exists (select 1 from public.capability_catalog
                 where capability_key = 'social.post.publish'),
    'the first proof target is not in the capability catalog';

  assert (select requires_verification from public.capability_catalog
          where capability_key = 'business.hours.update'),
    'a write capability does not require verification';

  begin
    insert into public.capability_catalog
      (capability_key, display_label, domain, verb)
    values ('NotDotted', 'Bad key', 'test', 'run');
    raise exception 'ASSERTION FAILED: an undotted capability key was accepted';
  exception when check_violation then
    null;  -- expected
  end;
end
$$;

-- ── 004 · execution is not evidence ─────────────────────────────────────────
-- The one that matters. A receipt may not claim VERIFIED unless something
-- went back and looked.
do $$
declare
  job uuid;
begin
  insert into public.execution_jobs (entity_slug, capability_key, status)
  values ('the-blue-crab', 'business.hours.update', 'verifying')
  returning id into job;

  begin
    insert into public.action_receipts (job_id, entity_slug, capability_key, status, summary)
    values (job, 'the-blue-crab', 'business.hours.update', 'VERIFIED',
            'Hours updated everywhere.');
    raise exception
      'ASSERTION FAILED: a VERIFIED receipt was issued with no verification check';
  exception when raise_exception then
    if position('no matching verification_check' in sqlerrm) = 0 then raise; end if;
  end;

  -- A FAILED receipt needs no check — reporting a failure is not a claim.
  insert into public.action_receipts (job_id, entity_slug, capability_key, status, summary)
  values (job, 'the-blue-crab', 'business.hours.update', 'FAILED',
          'Could not reach Google Business.');

  -- Now record a real read-back, and the receipt may be upgraded.
  insert into public.verification_checks (job_id, check_kind, status, expected, observed)
  values (job, 'read_back', 'VERIFIED', '{"close":"21:00"}'::jsonb, '{"close":"21:00"}'::jsonb);

  update public.action_receipts set status = 'VERIFIED' where job_id = job;

  assert (select status from public.action_receipts where job_id = job) = 'VERIFIED',
    'a receipt backed by a verification check was still refused';
end
$$;

-- Two clicks on publish are one job.
do $$
begin
  insert into public.execution_jobs (entity_slug, capability_key, idempotency_key)
  values ('the-blue-crab', 'social.post.publish', 'post-2026-08-24-a');
  begin
    insert into public.execution_jobs (entity_slug, capability_key, idempotency_key)
    values ('the-blue-crab', 'social.post.publish', 'post-2026-08-24-a');
    raise exception 'ASSERTION FAILED: the same idempotency key ran twice';
  exception when unique_violation then
    null;  -- expected
  end;

  -- The same key for a different business is a different job.
  insert into public.execution_jobs (entity_slug, capability_key, idempotency_key)
  values ('dockside-bar', 'social.post.publish', 'post-2026-08-24-a');
end
$$;

-- ── 005 · events are ordered by id, not by clock ────────────────────────────
do $$
declare
  a bigint; b bigint;
begin
  insert into public.platform_events (event_type, entity_slug, occurred_at)
  values ('business.hours.changed', 'the-blue-crab', now()) returning id into a;
  -- second event, stamped EARLIER than the first, as a node with a skewed
  -- clock would produce.
  insert into public.platform_events (event_type, entity_slug, occurred_at)
  values ('business.hours.changed', 'the-blue-crab', now() - interval '1 hour')
  returning id into b;

  assert b > a, 'event ids are not monotonic';

  begin
    insert into public.platform_events (event_type) values ('undotted');
    raise exception 'ASSERTION FAILED: an undotted event type was accepted';
  exception when check_violation then
    null;  -- expected
  end;
end
$$;

-- ── 006 · one open conflict per field ───────────────────────────────────────
do $$
declare
  c uuid;
begin
  insert into public.source_field_observations
    (entity_slug, field_path, value_json, source_system, source_kind, authority_rank)
  values ('the-blue-crab', 'hours.monday.close', '"21:00"'::jsonb, 'google_business', 'observed', 100),
         ('the-blue-crab', 'hours.monday.close', '"22:00"'::jsonb, 'yelp',            'observed', 100);

  insert into public.data_conflicts (entity_slug, field_path)
  values ('the-blue-crab', 'hours.monday.close') returning id into c;

  begin
    insert into public.data_conflicts (entity_slug, field_path)
    values ('the-blue-crab', 'hours.monday.close');
    raise exception 'ASSERTION FAILED: the same field raised two open conflicts';
  exception when unique_violation then
    null;  -- expected
  end;

  insert into public.data_conflict_options
    (conflict_id, value_json, display_value, source_system, is_selected)
  values (c, '"21:00"'::jsonb, 'Closes 9:00 PM',  'google_business', true),
         (c, '"22:00"'::jsonb, 'Closes 10:00 PM', 'yelp',            false);

  begin
    update public.data_conflict_options set is_selected = true
     where conflict_id = c and source_system = 'yelp';
    raise exception 'ASSERTION FAILED: two options were selected at once';
  exception when unique_violation then
    null;  -- expected
  end;

  assert (select option_count from public.data_conflicts_open where id = c) = 2,
    'the open-conflicts view is not counting options';

  -- Once resolved, the field is free to raise a new conflict later.
  update public.data_conflicts
     set status = 'resolved', resolved_at = now(), resolution_kind = 'owner_chose',
         canonical_value_json = '"21:00"'::jsonb
   where id = c;

  insert into public.data_conflicts (entity_slug, field_path)
  values ('the-blue-crab', 'hours.monday.close');
end
$$;

-- ── 007 · installs, and what did NOT come across ────────────────────────────
do $$
begin
  -- Three of the four entity_modules rows carry over. The fourth names a
  -- module_key that is not in module_catalog and is dropped on the floor,
  -- which is the point of joining rather than copying.
  assert (select count(*) from public.entity_module_preferences) = 3,
    format('expected 3 carried-across module preferences, got %s',
           (select count(*) from public.entity_module_preferences));

  assert not exists (select 1 from public.entity_module_preferences
                     where module_key = 'orphaned_module_key'),
    'a module_key with no catalog entry was carried across';

  -- The disabled row came across too. `enabled` was never a real decision, so
  -- it is not honoured, and it is not imported either.
  assert exists (select 1 from public.entity_module_preferences
                 where entity_slug = 'dockside-bar' and module_key = 'menu'),
    'the carry-across honoured entity_modules.enabled, which it must not';

  assert (select settings from public.entity_module_preferences
          where entity_slug = 'the-blue-crab' and module_key = 'menu')
         = '{"layout":"grid"}'::jsonb,
    'per-module settings were lost in the carry-across';

  assert (select sort_order from public.entity_module_preferences
          where entity_slug = 'the-blue-crab' and module_key = 'hours') = 20,
    'sort order was lost in the carry-across';
end
$$;

-- An install is one row per business per thing, and uninstalling is a status.
do $$
begin
  insert into public.app_catalog (app_key, name, surfaces)
  values ('song_request', 'Song Request', array['owner','customer']);

  insert into public.entity_app_installs (entity_slug, app_key)
  values ('the-blue-crab', 'song_request');

  begin
    insert into public.entity_app_installs (entity_slug, app_key)
    values ('the-blue-crab', 'song_request');
    raise exception 'ASSERTION FAILED: an app installed twice for one business';
  exception when unique_violation then
    null;  -- expected
  end;

  -- The business that never installed it has no row, which is the whole rule.
  assert not exists (select 1 from public.entity_app_installs
                     where entity_slug = 'dockside-bar' and app_key = 'song_request'),
    'an app appeared for a business that never installed it';

  -- A catalog entry cannot be deleted out from under an install.
  begin
    delete from public.app_catalog where app_key = 'song_request';
    raise exception 'ASSERTION FAILED: a catalog entry was removed while installed';
  exception when foreign_key_violation then
    null;  -- expected
  end;
end
$$;

select 'all kernel assertions passed' as result;
