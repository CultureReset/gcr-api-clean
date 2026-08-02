-- ============================================================================
-- LODGING 03 — MONEY: LEDGER, PAYOUTS, OWNER STATEMENTS  (additive only)
-- ============================================================================
-- Requires: 01, 02
-- Review file: DO NOT APPLY without explicit approval.
--
-- WHY A LEDGER AND NOT BALANCE COLUMNS:
-- The moment you hold a guest's money that belongs to a condo owner, minus
-- your commission, minus taxes owed to three separate authorities, minus a
-- cleaner's fee — single-column balances stop reconciling and there is no way
-- to find where the drift came from. Every movement is a double-entry pair:
-- one debit, one credit, same amount, same group_id. The invariant is
-- SUM(debit) = SUM(credit) for every group, forever.
--
-- Stripe stays the money mover (routes/stripe.js, Connect is already wired).
-- This is the BOOK of what moved and who it belongs to.
-- ============================================================================


-- ── 1. OWNERS — whose unit is it ────────────────────────────────────────────
-- The condo owner. Distinct from the management company (the `entity`) and
-- from the platform. A management company entity has many owners; an
-- owner-operator is simply their own single owner row.
--
-- DISPLAYS: owner portal login, statement header, admin owner directory, 1099s.
CREATE TABLE IF NOT EXISTS lodging_owners (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  user_id        text,                      -- links to the login that sees the owner portal
  display_name   text NOT NULL,
  legal_name     text,
  email          text,
  phone          text,
  mailing_address jsonb NOT NULL DEFAULT '{}',
  tax_id_last4   text,                      -- NEVER store a full SSN/EIN here
  tax_id_type    text,                      -- ssn|ein
  w9_on_file     boolean NOT NULL DEFAULT false,
  w9_url         text,
  payout_method  text,                      -- ach|check|stripe_connect
  payout_account_ref text,                  -- Stripe Connect acct_… or a bank token
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lodging_owners_entity ON lodging_owners (entity_slug, is_active);


-- ── 2. OWNER AGREEMENTS — the commission terms ──────────────────────────────
-- One agreement per owner per unit (an owner with three units may have three
-- different splits). Effective-dated, because terms get renegotiated and last
-- year's statements must keep reprinting with last year's rate.
--
-- DISPLAYS: owner portal terms, statement math, admin contract manager.
CREATE TABLE IF NOT EXISTS lodging_owner_agreements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug         text NOT NULL,
  owner_id            uuid NOT NULL,
  unit_id             uuid NOT NULL,
  ownership_percent   numeric NOT NULL DEFAULT 100,  -- co-owned units split the net
  commission_percent  numeric NOT NULL,              -- what the manager keeps of rent
  commission_basis    text NOT NULL DEFAULT 'rent_only',
    -- rent_only | rent_and_fees | gross
  cleaning_revenue_to text NOT NULL DEFAULT 'manager', -- manager|owner|passthrough
  owner_pays_cleaning_on_owner_stay boolean NOT NULL DEFAULT true,
  maintenance_approval_limit numeric,               -- auto-approve repairs under $X
  reserve_amount      numeric NOT NULL DEFAULT 0,   -- held back each period for repairs
  payout_frequency    text NOT NULL DEFAULT 'monthly', -- monthly|semimonthly|per_stay
  payout_day          integer,                      -- day of month
  effective_from      date NOT NULL,
  effective_to        date,
  document_url        text,
  signed_at           timestamptz,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_owner_agree_unit  ON lodging_owner_agreements (unit_id, is_active);
CREATE INDEX IF NOT EXISTS idx_owner_agree_owner ON lodging_owner_agreements (owner_id, is_active);


-- ── 3. ACCOUNTS — the chart of accounts ─────────────────────────────────────
-- Every ledger entry moves value between two of these. Kept deliberately
-- small; add accounts rather than adding columns elsewhere.
--
-- DISPLAYS: admin reconciliation, trial balance, trust-account report.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug  text,                        -- NULL = platform-level account
  code         text NOT NULL,               -- 'guest_receivable', 'owner_payable'
  name         text NOT NULL,
  account_type text NOT NULL,               -- asset|liability|revenue|expense|equity
  owner_id     uuid,                        -- per-owner payable sub-account
  unit_id      uuid,
  jurisdiction_id uuid,                     -- per-jurisdiction tax payable
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Uniqueness must treat NULL as a real value here: a platform-level account
-- has NULL entity_slug/owner_id/unit_id/jurisdiction_id, and a plain
-- UNIQUE(...) would let the same account be inserted repeatedly because
-- NULL <> NULL. COALESCE keys it properly and keeps ON CONFLICT working.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_accounts_key ON ledger_accounts (
  COALESCE(entity_slug, ''),
  code,
  COALESCE(owner_id,        '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(unit_id,         '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(jurisdiction_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_entity ON ledger_accounts (entity_slug, code);


-- ── 4. LEDGER ENTRIES — append only, never updated, never deleted ───────────
-- A correction is a NEW reversing pair, not an edit. That is what makes the
-- book auditable.
--
-- Example — a $1,000 stay, 20% commission, $175 cleaning, $130 tax:
--   group A "guest paid":     DR cash 1305        CR guest_receivable 1305
--   group B "revenue split":  DR guest_receivable 1305
--                             CR owner_payable 800, CR commission_revenue 200,
--                             CR cleaning_revenue 175, CR tax_payable 130
--   group C "payout":         DR owner_payable 800  CR cash 800
--
-- DISPLAYS: admin reconciliation, owner statement lines, revenue reports,
-- tax remittance report, per-stay money trail.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug   text NOT NULL,
  group_id      uuid NOT NULL,              -- the transaction; debits must equal credits
  account_id    uuid NOT NULL,
  direction     text NOT NULL,              -- debit|credit
  amount        numeric NOT NULL CHECK (amount >= 0),
  currency      text NOT NULL DEFAULT 'USD',

  -- what caused this
  ref_type      text,                       -- stay|payment|refund|payout|expense|adjustment|tax_remittance
  ref_id        uuid,
  stay_id       uuid,
  owner_id      uuid,
  unit_id       uuid,

  memo          text,
  occurred_on   date NOT NULL DEFAULT CURRENT_DATE,
  posted_at     timestamptz NOT NULL DEFAULT now(),
  created_by    text
);
CREATE INDEX IF NOT EXISTS idx_ledger_group   ON ledger_entries (group_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries (account_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_ledger_entity  ON ledger_entries (entity_slug, occurred_on);
CREATE INDEX IF NOT EXISTS idx_ledger_stay    ON ledger_entries (stay_id);
CREATE INDEX IF NOT EXISTS idx_ledger_owner   ON ledger_entries (owner_id, occurred_on);


-- ── 5. PAYMENTS + SCHEDULES ─────────────────────────────────────────────────
-- Condo weeks are almost never paid in full up front: deposit at booking,
-- balance 30 days before arrival. The schedule is planned rows; payments are
-- what actually cleared.
--
-- DISPLAYS: checkout ("$500 today, $1,305 due Jul 3"), guest Trips balance,
-- host reservation detail, admin AR aging, automated balance reminders.
CREATE TABLE IF NOT EXISTS lodging_payment_schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug   text NOT NULL,
  stay_id       uuid NOT NULL,
  sequence      integer NOT NULL DEFAULT 1,
  label         text,                       -- "Deposit", "Balance"
  amount_due    numeric NOT NULL,
  due_on        date NOT NULL,
  status        text NOT NULL DEFAULT 'scheduled', -- scheduled|paid|overdue|waived|cancelled
  reminded_at   timestamptz,
  paid_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stay_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_pay_sched_due ON lodging_payment_schedules (due_on, status);

CREATE TABLE IF NOT EXISTS lodging_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug     text NOT NULL,
  stay_id         uuid,
  schedule_id     uuid,
  amount          numeric NOT NULL,
  currency        text NOT NULL DEFAULT 'USD',
  direction       text NOT NULL DEFAULT 'charge',   -- charge|refund
  method          text,                             -- card|ach|cash|check|channel
  processor       text NOT NULL DEFAULT 'stripe',   -- stripe|square|manual|airbnb|vrbo
  processor_ref   text,                             -- pi_… / ch_… / channel payout id
  processor_fee   numeric,
  status          text NOT NULL DEFAULT 'pending',  -- pending|succeeded|failed|disputed|refunded
  failure_reason  text,
  ledger_group_id uuid,                             -- ties to ledger_entries.group_id
  received_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lodging_payments_stay   ON lodging_payments (stay_id);
CREATE INDEX IF NOT EXISTS idx_lodging_payments_entity ON lodging_payments (entity_slug, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lodging_payments_ref    ON lodging_payments (processor, processor_ref);


-- ── 6. SECURITY DEPOSITS + DAMAGE CLAIMS ────────────────────────────────────
-- Held (or authorized-not-captured), then released or claimed against.
--
-- DISPLAYS: guest Trips "deposit released", host claim workflow, admin
-- dispute queue, owner statement (damage recovery).
CREATE TABLE IF NOT EXISTS lodging_security_deposits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug   text NOT NULL,
  stay_id       uuid NOT NULL,
  amount        numeric NOT NULL,
  hold_type     text NOT NULL DEFAULT 'authorization', -- authorization|charge|damage_waiver
  processor_ref text,
  status        text NOT NULL DEFAULT 'held',  -- held|released|claimed|partially_claimed|expired
  held_at       timestamptz,
  release_due_on date,
  released_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deposits_stay    ON lodging_security_deposits (stay_id);
CREATE INDEX IF NOT EXISTS idx_deposits_release ON lodging_security_deposits (release_due_on) WHERE status = 'held';

CREATE TABLE IF NOT EXISTS lodging_damage_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug   text NOT NULL,
  stay_id       uuid NOT NULL,
  deposit_id    uuid,
  description   text NOT NULL,
  amount_claimed numeric NOT NULL,
  amount_recovered numeric,
  evidence_urls text[],
  status        text NOT NULL DEFAULT 'open', -- open|guest_notified|agreed|disputed|resolved|written_off
  reported_by   text,
  resolved_at   timestamptz,
  resolution_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_damage_claims_stay ON lodging_damage_claims (stay_id, status);


-- ── 7. EXPENSES — what gets deducted from an owner ──────────────────────────
-- Repairs, supplies, cleaning charged back, HOA pass-throughs. Each one either
-- hits the owner's statement or the manager's own P&L, never ambiguously both.
--
-- DISPLAYS: owner statement detail, admin expense entry, unit profitability.
CREATE TABLE IF NOT EXISTS lodging_expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug   text NOT NULL,
  unit_id       uuid,
  owner_id      uuid,
  stay_id       uuid,                        -- when caused by a specific stay
  work_order_id uuid,                        -- → lodging_work_orders (04)
  category      text NOT NULL,               -- repair|supplies|cleaning|utilities|hoa|marketing|other
  vendor_name   text,
  description   text NOT NULL,
  amount        numeric NOT NULL,
  billed_to     text NOT NULL DEFAULT 'owner', -- owner|manager|guest
  incurred_on   date NOT NULL DEFAULT CURRENT_DATE,
  receipt_url   text,
  statement_id  uuid,                        -- set when it lands on a statement
  approved_by   text,
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_owner  ON lodging_expenses (owner_id, incurred_on);
CREATE INDEX IF NOT EXISTS idx_expenses_unit   ON lodging_expenses (unit_id, incurred_on);
CREATE INDEX IF NOT EXISTS idx_expenses_unbilled ON lodging_expenses (entity_slug) WHERE statement_id IS NULL;


-- ── 8. OWNER STATEMENTS — the monthly number the owner actually cares about ─
-- Generated per owner per unit per period, then frozen. lines holds the
-- rendered detail so a reprint of March is identical a year later even after
-- rates, commissions and expenses have all changed.
--
-- DISPLAYS: owner portal statements list + PDF, admin payout run, the email
-- that goes out on the 10th of each month.
CREATE TABLE IF NOT EXISTS lodging_owner_statements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug       text NOT NULL,
  owner_id          uuid NOT NULL,
  unit_id           uuid,                    -- NULL = combined across owner's units
  period_start      date NOT NULL,
  period_end        date NOT NULL,

  gross_rent        numeric NOT NULL DEFAULT 0,
  gross_fees        numeric NOT NULL DEFAULT 0,
  taxes_collected   numeric NOT NULL DEFAULT 0,
  commission_amount numeric NOT NULL DEFAULT 0,
  cleaning_amount   numeric NOT NULL DEFAULT 0,
  expenses_total    numeric NOT NULL DEFAULT 0,
  reserve_held      numeric NOT NULL DEFAULT 0,
  adjustments       numeric NOT NULL DEFAULT 0,
  net_payout        numeric NOT NULL DEFAULT 0,

  nights_booked     integer,
  nights_available  integer,
  occupancy_percent numeric,
  adr               numeric,                 -- average daily rate
  revpar            numeric,                 -- revenue per available night

  lines             jsonb NOT NULL DEFAULT '[]',  -- frozen render
  status            text NOT NULL DEFAULT 'draft', -- draft|issued|paid|void
  issued_at         timestamptz,
  paid_at           timestamptz,
  payout_id         uuid,
  pdf_url           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, unit_id, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_statements_owner  ON lodging_owner_statements (owner_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_statements_entity ON lodging_owner_statements (entity_slug, status);


-- ── 9. PAYOUTS — money leaving for an owner ─────────────────────────────────
-- DISPLAYS: admin payout run screen, owner portal "paid Mar 10 — $4,182".
CREATE TABLE IF NOT EXISTS lodging_payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug     text NOT NULL,
  owner_id        uuid NOT NULL,
  amount          numeric NOT NULL,
  currency        text NOT NULL DEFAULT 'USD',
  method          text,                      -- ach|check|stripe_connect
  processor_ref   text,
  status          text NOT NULL DEFAULT 'pending', -- pending|processing|paid|failed|cancelled
  scheduled_for   date,
  paid_at         timestamptz,
  failure_reason  text,
  ledger_group_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payouts_owner  ON lodging_payouts (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON lodging_payouts (entity_slug, status);


-- ── 10. TAX REMITTANCES — what you filed and when ───────────────────────────
-- Collected tax is somebody else's money sitting in your account. This is the
-- record of handing it over, per jurisdiction per period.
--
-- DISPLAYS: admin tax dashboard ("$4,210 collected, $0 remitted, due Aug 20"),
-- filing worksheet export.
CREATE TABLE IF NOT EXISTS lodging_tax_remittances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug     text NOT NULL,
  jurisdiction_id uuid NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  taxable_base    numeric NOT NULL DEFAULT 0,
  amount_collected numeric NOT NULL DEFAULT 0,
  amount_remitted numeric,
  status          text NOT NULL DEFAULT 'open', -- open|filed|paid|amended
  filed_at        timestamptz,
  confirmation_ref text,
  ledger_group_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_slug, jurisdiction_id, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_remittances_due ON lodging_tax_remittances (entity_slug, status, period_end);


-- ── SEED: the standard chart of accounts, platform level ────────────────────
INSERT INTO ledger_accounts (entity_slug, code, name, account_type) VALUES
  (NULL, 'cash',                'Cash / bank',              'asset'),
  (NULL, 'guest_receivable',    'Guest receivable',         'asset'),
  (NULL, 'owner_payable',       'Owner payable',            'liability'),
  (NULL, 'tax_payable',         'Lodging tax payable',      'liability'),
  (NULL, 'deposits_held',       'Security deposits held',   'liability'),
  (NULL, 'deferred_revenue',    'Deferred revenue',         'liability'),
  (NULL, 'commission_revenue',  'Commission revenue',       'revenue'),
  (NULL, 'cleaning_revenue',    'Cleaning revenue',         'revenue'),
  (NULL, 'fee_revenue',         'Other fee revenue',        'revenue'),
  (NULL, 'processor_fees',      'Payment processor fees',   'expense'),
  (NULL, 'maintenance_expense', 'Maintenance expense',      'expense'),
  (NULL, 'refunds_issued',      'Refunds issued',           'expense')
ON CONFLICT (
  COALESCE(entity_slug, ''),
  code,
  COALESCE(owner_id,        '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(unit_id,         '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(jurisdiction_id, '00000000-0000-0000-0000-000000000000'::uuid)
) DO NOTHING;
