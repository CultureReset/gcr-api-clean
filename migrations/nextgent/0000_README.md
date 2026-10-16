# NEXT GENT phase-1 data migrations (DRAFT, NOT RUN)
- Local only. Never run against Supabase `mkepugvdlktfsossumox` until Matt approves the run, and only after a dry run on a copy.
- Everything is created in a new Postgres schema `ng`, so nothing collides with live `public.*` tables.
- Order: 0001 → 0010. Backfill files (09xx) copy from `public.*` and are idempotent (`on conflict do nothing`).
- Key: every business row is keyed by `business_id uuid` = `public.entity.id`. `slug` is kept on `ng.business` only.
- Money: integer cents plus a currency column. Times: timestamptz. Local opening hours: `time` plus the business timezone.
- Mapping and rationale: /workspace/wiring/DATA-MODEL.md
