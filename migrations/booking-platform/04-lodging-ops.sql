-- ============================================================================
-- LODGING 04 — FIELD OPS: CLEANING, MAINTENANCE, ACCESS  (additive only)
-- ============================================================================
-- Requires: 01, 02, 03
-- Review file: DO NOT APPLY without explicit approval.
--
-- This block is the difference between an "Airbnb clone" and a condo rental
-- COMPANY. Airbnb never cleans anything — the host does. If you are running
-- units on an owner's behalf, turnover IS the business: every checkout
-- generates a clean, every clean has a window bounded by the next arrival,
-- and a missed turnover is a guest standing in a dirty condo at 4pm.
--
-- Feeds the mobile ops view (cleaners/maintenance), not the guest or owner.
-- ============================================================================


-- ── 1. VENDORS — cleaners, plumbers, HVAC, pest ─────────────────────────────
-- DISPLAYS: admin vendor directory, task assignment picker, expense attribution.
CREATE TABLE IF NOT EXISTS lodging_vendors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug   text NOT NULL,
  name          text NOT NULL,
  vendor_type   text NOT NULL,              -- cleaning|maintenance|pool|pest|hvac|laundry|inspection
  contact_name  text,
  phone         text,
  email         text,
  user_id       text,                       -- if they log into the ops view
  hourly_rate   numeric,
  flat_rate     numeric,
  insured_until date,
  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendors_entity ON lodging_vendors (entity_slug, vendor_type, is_active);


-- ── 2. CLEANING TASKS — auto-generated on every checkout ────────────────────
-- window_start is the departure time of the leaving stay; window_end is the
-- check-in time of the next arrival. Same-day turnovers (both on one date)
-- are the high-risk case and are flagged so they can be surfaced first.
--
-- DISPLAYS: ops mobile "today's cleans", host calendar overlay, admin
-- turnover board, the late-clean alert.
CREATE TABLE IF NOT EXISTS lodging_cleaning_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug     text NOT NULL,
  unit_id         uuid NOT NULL,
  stay_id         uuid,                     -- the departing stay that triggered it
  next_stay_id    uuid,                     -- the arrival that bounds the window
  task_type       text NOT NULL DEFAULT 'turnover', -- turnover|deep|inspection|mid_stay|owner_prep
  scheduled_date  date NOT NULL,
  window_start    time,
  window_end      time,
  is_same_day_turn boolean NOT NULL DEFAULT false,
  priority        text NOT NULL DEFAULT 'normal',   -- low|normal|urgent

  vendor_id       uuid,
  assigned_to     text,
  assigned_at     timestamptz,

  status          text NOT NULL DEFAULT 'scheduled',
    -- scheduled|assigned|in_progress|complete|verified|skipped|blocked
  started_at      timestamptz,
  completed_at    timestamptz,
  verified_at     timestamptz,
  verified_by     text,

  checklist       jsonb NOT NULL DEFAULT '[]',  -- [{"item":"Strip beds","done":true}]
  photo_urls      text[],
  notes           text,
  issues_found    text,

  cost            numeric,
  billed_to       text NOT NULL DEFAULT 'guest_fee', -- guest_fee|owner|manager
  expense_id      uuid,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cleaning_date   ON lodging_cleaning_tasks (entity_slug, scheduled_date, status);
CREATE INDEX IF NOT EXISTS idx_cleaning_unit   ON lodging_cleaning_tasks (unit_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_cleaning_vendor ON lodging_cleaning_tasks (vendor_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_cleaning_open   ON lodging_cleaning_tasks (scheduled_date)
  WHERE status IN ('scheduled', 'assigned', 'in_progress');


-- ── 3. MAINTENANCE TICKETS ──────────────────────────────────────────────────
-- Raised by a guest mid-stay, a cleaner at turnover, or an inspection. Kept
-- separate from work orders: a ticket is the PROBLEM, a work order is the
-- dispatched FIX (one ticket can need two trades).
--
-- DISPLAYS: ops mobile, host maintenance tab, owner portal (approval over
-- limit), admin open-ticket board.
CREATE TABLE IF NOT EXISTS lodging_maintenance_tickets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  unit_id        uuid NOT NULL,
  stay_id        uuid,                      -- if a guest reported it in-stay
  reported_by    text,                      -- guest|cleaner|inspector|owner|staff
  reporter_name  text,
  category       text,                      -- plumbing|electrical|hvac|appliance|structural|pest|wifi
  severity       text NOT NULL DEFAULT 'normal', -- low|normal|high|emergency
  blocks_occupancy boolean NOT NULL DEFAULT false,
  title          text NOT NULL,
  description    text,
  photo_urls     text[],
  status         text NOT NULL DEFAULT 'open',
    -- open|acknowledged|awaiting_approval|scheduled|in_progress|resolved|closed|wont_fix
  resolved_at    timestamptz,
  resolution_note text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_unit   ON lodging_maintenance_tickets (unit_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_open   ON lodging_maintenance_tickets (entity_slug, severity)
  WHERE status NOT IN ('resolved', 'closed', 'wont_fix');


-- ── 4. WORK ORDERS — the dispatched fix ─────────────────────────────────────
-- Carries the money and the owner-approval gate. When cost exceeds the
-- agreement's maintenance_approval_limit, it waits on the owner.
--
-- DISPLAYS: vendor's job list, owner approval request, expense creation.
CREATE TABLE IF NOT EXISTS lodging_work_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug     text NOT NULL,
  ticket_id       uuid,
  unit_id         uuid NOT NULL,
  vendor_id       uuid,
  trade           text,                     -- plumbing|electrical|hvac|general
  description     text NOT NULL,
  scheduled_for   date,
  scheduled_window text,
  estimated_cost  numeric,
  actual_cost     numeric,
  requires_owner_approval boolean NOT NULL DEFAULT false,
  approved_by     text,
  approved_at     timestamptz,
  status          text NOT NULL DEFAULT 'draft',
    -- draft|awaiting_approval|approved|dispatched|in_progress|complete|cancelled
  completed_at    timestamptz,
  invoice_url     text,
  expense_id      uuid,
  photo_urls      text[],
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_orders_unit   ON lodging_work_orders (unit_id, status);
CREATE INDEX IF NOT EXISTS idx_work_orders_vendor ON lodging_work_orders (vendor_id, scheduled_for);


-- ── 5. INSPECTIONS — photo-checklist proof ──────────────────────────────────
-- Pre-arrival and post-departure. The post-departure photo set is the evidence
-- behind every damage claim; without it a claim is one party's word.
--
-- DISPLAYS: ops mobile checklist, damage claim evidence, owner reassurance.
CREATE TABLE IF NOT EXISTS lodging_inspections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug    text NOT NULL,
  unit_id        uuid NOT NULL,
  stay_id        uuid,
  inspection_type text NOT NULL DEFAULT 'post_departure', -- pre_arrival|post_departure|periodic|owner_prep
  inspected_by   text,
  vendor_id      uuid,
  checklist      jsonb NOT NULL DEFAULT '[]',
  photo_urls     text[],
  passed         boolean,
  issues_found   text,
  ticket_id      uuid,                      -- auto-raised if it failed
  performed_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inspections_stay ON lodging_inspections (stay_id);
CREATE INDEX IF NOT EXISTS idx_inspections_unit ON lodging_inspections (unit_id, performed_at DESC);


-- ── 6. ACCESS CODES — per stay, auto-expiring ───────────────────────────────
-- Smart-lock or gate code issued per reservation and revoked at checkout. A
-- code that outlives its stay is a real security problem, so expiry is a
-- column and not a convention.
--
-- DISPLAYS: guest arrival email + Trips tab, ops mobile, admin access audit.
CREATE TABLE IF NOT EXISTS lodging_access_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug   text NOT NULL,
  unit_id       uuid NOT NULL,
  stay_id       uuid,
  code_type     text NOT NULL DEFAULT 'door', -- door|gate|elevator|amenity|wifi
  label         text,
  code_value    text,                       -- treat as a secret; restrict column access
  lock_provider text,                       -- schlage|yale|august|igloohome|manual
  lock_ref      text,
  valid_from    timestamptz,
  valid_until   timestamptz,
  status        text NOT NULL DEFAULT 'pending', -- pending|active|expired|revoked|failed
  issued_at     timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_codes_stay ON lodging_access_codes (stay_id);
CREATE INDEX IF NOT EXISTS idx_access_expiry     ON lodging_access_codes (valid_until) WHERE status = 'active';


-- ── 7. ARRIVAL INSTRUCTIONS — per unit, sent pre-arrival ────────────────────
-- Directions, parking, elevator, trash, wifi, checkout steps. Templated per
-- unit, merged with the stay's access code at send time.
--
-- DISPLAYS: pre-arrival email/SMS, guest Trips tab, printed welcome sheet.
CREATE TABLE IF NOT EXISTS lodging_arrival_instructions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug        text NOT NULL,
  unit_id            uuid,                  -- NULL = entity-wide default
  directions         text,
  parking_info       text,
  parking_pass_required boolean NOT NULL DEFAULT false,
  building_access    text,
  elevator_info      text,
  wifi_network       text,
  wifi_password      text,
  trash_info         text,
  amenity_info       text,
  checkout_steps     text,
  emergency_contact  text,
  send_hours_before  integer NOT NULL DEFAULT 48,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_slug, unit_id)
);


-- ── 8. SUPPLY INVENTORY (v3, thin on purpose) ───────────────────────────────
-- Linens, paper goods, coffee. Only matters once a company runs enough units
-- that restocking is a route, not an errand.
--
-- DISPLAYS: ops restock list, expense generation.
CREATE TABLE IF NOT EXISTS lodging_supplies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug   text NOT NULL,
  unit_id       uuid,                       -- NULL = warehouse stock
  item_name     text NOT NULL,
  category      text,                       -- linens|paper|kitchen|toiletries|welcome
  par_level     integer,                    -- target on hand
  quantity      integer NOT NULL DEFAULT 0,
  unit_cost     numeric,
  last_restocked date,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplies_unit ON lodging_supplies (unit_id);
CREATE INDEX IF NOT EXISTS idx_supplies_low  ON lodging_supplies (entity_slug)
  WHERE par_level IS NOT NULL;
