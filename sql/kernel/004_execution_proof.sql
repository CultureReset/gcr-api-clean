-- ############################################################################
-- ##  NOT YET APPLIED. Read sql/kernel/README.md first. Confirm the target  ##
-- ##  is "cyber check" (mkepugvdlktfsossumox). See HANDOFF.md.              ##
-- ############################################################################

-- ============================================================================
-- GHOST KERNEL · 004 · EXECUTION, VERIFICATION AND RECEIPTS
-- ============================================================================
--
-- The claim this platform makes is not "we can update your hours in six
-- places." Zapier can do that. The claim is "we updated your hours in six
-- places and here is the proof from each one."
--
-- Which means the thing every other automation product treats as the end of
-- the job — the API returned 200 — is treated here as the middle of it.
--
--     job        someone asked for a capability
--     attempt    one route was tried, once
--     check      we went back and looked
--     receipt    what we are willing to say happened
--     evidence   what we looked at
--
-- Four separate tables rather than status columns on one, because they answer
-- to different clocks and different authors. An attempt is written by an
-- executor. A check is written by a verifier that must not be the executor —
-- if the same code that performed the write also decides the write worked,
-- the verification proves nothing but that the code is consistent with itself.
--
-- A receipt is only issued after a check. `verified + evidenced + logged`, or
-- it is not done. There is deliberately no path in this schema from "attempt
-- succeeded" straight to "receipt VERIFIED": the trigger at the bottom refuses
-- it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- JOBS
-- ----------------------------------------------------------------------------
-- One request for one capability against one business. Created before any
-- policy decision is made, so a refusal is recorded rather than silent — a
-- NEVER is an event a business is entitled to see.
--
-- `idempotency_key` is unique per business. Two clicks on "publish" are one
-- post. This is the only defence against a retry storm reaching a customer's
-- Instagram account.
-- ----------------------------------------------------------------------------
create table if not exists public.execution_jobs (
  id                  uuid primary key default gen_random_uuid(),
  entity_slug         text not null references public.entity(slug) on update cascade on delete cascade,
  capability_key      text not null references public.capability_catalog(capability_key),

  -- Who asked. Exactly one of these should be set; an agent acting for a
  -- person carries both, and that is the case worth being able to audit.
  requested_by_user_id  uuid,
  requested_by_agent_id text,
  source              text not null default 'dashboard'
                      check (source in ('dashboard','agent','mcp','automation','device','system')),

  idempotency_key     text,
  input               jsonb not null default '{}'::jsonb,

  -- The policy decision, recorded as taken. `denied` is a real outcome and it
  -- is kept, not discarded.
  policy_decision     text check (policy_decision in ('AUTO','ASK','NEVER')),
  policy_reason       text,
  approved_by_user_id uuid,
  approved_at         timestamptz,

  status              text not null default 'queued'
                      check (status in ('queued','awaiting_approval','running','verifying',
                                        'succeeded','partial','failed','cancelled','denied')),

  workflow_id         text,               -- durable engine's handle, if one ran it
  correlation_id      uuid not null default gen_random_uuid(),

  attempts_made       integer not null default 0,
  max_attempts        integer not null default 3,

  scheduled_for       timestamptz,
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (entity_slug, idempotency_key)
);

create index if not exists execution_jobs_queue_idx
  on public.execution_jobs (status, coalesce(scheduled_for, created_at))
  where status in ('queued','awaiting_approval','running','verifying');

create index if not exists execution_jobs_entity_idx
  on public.execution_jobs (entity_slug, created_at desc);

create index if not exists execution_jobs_correlation_idx
  on public.execution_jobs (correlation_id);

-- ----------------------------------------------------------------------------
-- ATTEMPTS
-- ----------------------------------------------------------------------------
-- One try down one route. Kept per attempt rather than collapsed onto the job,
-- because "it worked on the third try, over Android, after the web UI moved"
-- is the sentence the whole AppMap idea depends on being able to write.
--
-- `error_signature` is the grouping key for repair: a stable hash of what went
-- wrong (selector missing, element moved, auth expired), not the message text,
-- which varies per run.
-- ----------------------------------------------------------------------------
create table if not exists public.execution_attempts (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references public.execution_jobs(id) on delete cascade,
  route_id          uuid references public.execution_routes(id) on delete set null,
  implementation_id uuid references public.capability_implementations(id) on delete set null,

  attempt_no        integer not null,
  status            text not null default 'running'
                    check (status in ('running','succeeded','failed','timed_out','aborted')),

  request_payload   jsonb,
  response_payload  jsonb,

  error_code        text,
  error_message     text,
  error_signature   text,

  -- Where it physically ran. A browser run and a phone run are both real, and
  -- when a customer account gets flagged this is how it gets traced back.
  node_id           text,
  device_id         text,

  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  duration_ms       integer,

  unique (job_id, attempt_no)
);

create index if not exists execution_attempts_job_idx
  on public.execution_attempts (job_id, attempt_no);

create index if not exists execution_attempts_error_signature_idx
  on public.execution_attempts (error_signature, started_at desc)
  where error_signature is not null;

-- ----------------------------------------------------------------------------
-- VERIFICATION CHECKS
-- ----------------------------------------------------------------------------
-- Going back and looking. Expected against observed, with the difference kept.
--
-- The five statuses are not three. UNKNOWN — we could not see — is a distinct
-- answer from MISMATCH — we saw, and it is wrong — and collapsing them would
-- let "the page wouldn't load" quietly become "it worked."
-- ----------------------------------------------------------------------------
create table if not exists public.verification_checks (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.execution_jobs(id) on delete cascade,
  attempt_id    uuid references public.execution_attempts(id) on delete set null,

  check_kind    text not null
                check (check_kind in ('read_back','api_get','screenshot_diff','dom_assert','human')),
  target        text,                     -- what was looked at: a URL, an app screen, an endpoint

  expected      jsonb,
  observed      jsonb,
  diff          jsonb,

  status        text not null
                check (status in ('VERIFIED','PARTIAL','MISMATCH','UNKNOWN','FAILED')),
  confidence    numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  notes         text,

  -- Must not be the same component that performed the write.
  checked_by    text,
  checked_at    timestamptz not null default now()
);

create index if not exists verification_checks_job_idx
  on public.verification_checks (job_id, checked_at desc);

-- ----------------------------------------------------------------------------
-- RECEIPTS
-- ----------------------------------------------------------------------------
-- What the platform is willing to state, to a customer, about what happened.
-- One per job.
--
-- `canonical_before` / `canonical_after` are the business's own truth on either
-- side, so a receipt reads as a change to their data and not as a log line
-- about our infrastructure.
--
-- On signing: some of the material for this project describes "version locking
-- (blockchain)". Nothing here is a blockchain, and nothing needs to be. What
-- the claim actually requires is that a receipt cannot be altered after issue
-- without detection, which is what `content_hash`, `signature` and
-- `signer_key_id` give — a detached signature over a canonical serialization,
-- verifiable by anyone holding the public key. If a customer ever needs a
-- third party to attest the timestamp, that is a transparency log, and it
-- attaches here without changing these columns.
-- ----------------------------------------------------------------------------
create table if not exists public.action_receipts (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null unique references public.execution_jobs(id) on delete cascade,
  entity_slug       text not null references public.entity(slug) on update cascade on delete cascade,
  capability_key    text not null references public.capability_catalog(capability_key),

  status            text not null
                    check (status in ('VERIFIED','PARTIAL','MISMATCH','UNKNOWN','FAILED')),
  summary           text not null,        -- one sentence, written for the business owner

  canonical_before  jsonb,
  canonical_after   jsonb,
  targets           jsonb not null default '[]'::jsonb,  -- which surfaces were landed on

  issued_at         timestamptz not null default now(),
  content_hash      text,                 -- sha256 over the canonical serialization
  signature         text,
  signer_key_id     text,

  created_at        timestamptz not null default now()
);

create index if not exists action_receipts_entity_idx
  on public.action_receipts (entity_slug, issued_at desc);

-- ----------------------------------------------------------------------------
-- EVIDENCE
-- ----------------------------------------------------------------------------
-- The artifacts. Screenshots, DOM snapshots, HTTP responses, video of a phone.
--
-- Content is not stored inline: these are large, and some of them will contain
-- a customer's private screen. `storage_path` points at object storage;
-- `sha256` is what makes the pointer trustworthy after the fact.
-- ----------------------------------------------------------------------------
create table if not exists public.receipt_evidence (
  id            uuid primary key default gen_random_uuid(),
  receipt_id    uuid not null references public.action_receipts(id) on delete cascade,
  check_id      uuid references public.verification_checks(id) on delete set null,

  kind          text not null
                check (kind in ('screenshot','dom_snapshot','http_response','log','video','file')),
  storage_path  text not null,
  content_type  text,
  byte_size     bigint,
  sha256        text not null,

  -- Evidence of a customer's screen is customer data. It expires.
  redacted      boolean not null default false,
  retain_until  timestamptz,

  captured_at   timestamptz not null default now(),
  meta          jsonb not null default '{}'::jsonb
);

create index if not exists receipt_evidence_receipt_idx
  on public.receipt_evidence (receipt_id);

create index if not exists receipt_evidence_retention_idx
  on public.receipt_evidence (retain_until) where retain_until is not null;

-- ----------------------------------------------------------------------------
-- THE RULE, ENFORCED
-- ----------------------------------------------------------------------------
-- A receipt may not claim VERIFIED unless a verification check said so.
--
-- This exists as a trigger rather than as a line in a service, because it is
-- the one claim the entire product rests on and services get rewritten. If
-- someone later needs to issue a VERIFIED receipt and finds this in the way,
-- that is the check working.
-- ----------------------------------------------------------------------------
create or replace function public.kernel_receipt_requires_verification()
returns trigger
language plpgsql
as $fn$
begin
  if new.status in ('VERIFIED','PARTIAL') then
    if not exists (
      select 1 from public.verification_checks v
      where v.job_id = new.job_id
        and v.status = new.status
    ) then
      raise exception
        'receipt % claims % with no matching verification_check for job %',
        new.id, new.status, new.job_id
        using hint = 'Execution is not evidence. Record the read-back first.';
    end if;
  end if;
  return new;
end;
$fn$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'action_receipts_require_verification'
      and tgrelid = 'public.action_receipts'::regclass
  ) then
    create trigger action_receipts_require_verification
      before insert or update on public.action_receipts
      for each row execute function public.kernel_receipt_requires_verification();
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- updated_at trigger
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'execution_jobs_touch_updated_at'
      and tgrelid = 'public.execution_jobs'::regclass
  ) then
    create trigger execution_jobs_touch_updated_at
      before update on public.execution_jobs
      for each row execute function public.kernel_touch_updated_at();
  end if;
end
$$;
