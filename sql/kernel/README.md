# The kernel migrations

Seven files. **None of them has been applied to any database.**

They add the layer everything else in Ghost stands on: who a caller is, which
business they are acting as, what the platform is allowed to do on that
business's behalf, and what proof it kept. Nothing here changes an existing
table's shape, and nothing here drops or empties anything.

## Before you run any of this

The last time SQL from this repository was applied without checking, it went to
the wrong Supabase project. Seven files landed on a database nobody uses.
`HANDOFF.md` in the repository root is the account of it, and the rule it ends
with is the rule here: **do not guess.**

There are three projects on this account holding a table called `entity` with a
few thousand rows in it. Two of them are not the database. The name will not
tell you which is which — one of them is literally called "gulf coast radar".

Confirm before every session that writes:

```sql
select to_regclass('public.platform_connections');
```

`cyber check` (`mkepugvdlktfsossumox`) is the only one where that returns a
table. Or read `SUPABASE_URL` off the Vercel project, which is the same answer
arrived at from the other side.

If the SQL connection times out, that is this project's transport being
unreliable — it is documented in `CLAUDE.md`. Retry. Do not switch to a project
that answers faster.

## Test them first

```bash
./scripts/test-kernel-sql.sh
```

That starts a throwaway PostgreSQL, builds a stub of the live tables these
migrations depend on (`test/stub_live_schema.sql`), applies all seven **twice**,
runs `test/assertions.sql`, and destroys the cluster. It never reads a
connection string and cannot reach Supabase.

Applying twice is the point: this project's SQL connection times out mid-
statement, so "run it again" has to be safe. Every file is
create-if-not-exists, add-column-if-not-exists and on-conflict-do-nothing, and
that script is what keeps it true.

The assertions are not syntax checks. They are the properties the design rests
on — that a receipt cannot claim VERIFIED without a verification check, that
discovery never classifies a table on its own, that the same idempotency key
cannot run twice. If you change a migration and an assertion fails, the
assertion is probably right.

## Order, and what each file is for

Run in numeric order. Later files reference earlier ones.

| | | |
|---|---|---|
| `001` | identity and tenancy | `workspaces`, `workspace_members`, `workspace_entities`, `roles`, `role_permissions`. Constraints on `entity_owners`. Parent/child on `entity`. |
| `002` | the table registry | `table_registry`, `column_registry`, and the `table_registry_gaps` view. |
| `003` | capabilities | `capability_catalog`, `capability_implementations`, `execution_routes`. |
| `004` | execution and proof | `execution_jobs`, `execution_attempts`, `verification_checks`, `action_receipts`, `receipt_evidence`. |
| `005` | events | `platform_events`, `event_consumers`. |
| `006` | provenance | `source_field_observations`, `data_conflicts`, `data_conflict_options`. |
| `007` | the six ecosystems | catalogs and install tables for apps, device apps, plugins, automations; `entity_module_preferences`. |

## The three things worth knowing before reading the SQL

**`entity_owners` has zero rows.** That is the production blocker, not a
detail. `middleware/ownerAuth.js` resolves a logged-in person to a business
through that table, finds nothing, and every handler downstream has no slug to
filter on. `001` gives it the constraints it needs to be trusted; filling it is
a separate step and it is the first one that matters.

**The registry replaces a rule that fails open.** `lib/businessTables.js`
currently decides what a business can see by asking whether a table has an
`entity_slug` column. There are 319 such columns in this database. A new table
becomes visible the moment PostgREST notices it — no review, no permission.
`002` inverts that: discovery proposes, a person decides, and anything nobody
has decided about is invisible. Seeding it on the live database therefore
exposes nothing; it only makes the backlog visible.

**Execution is not evidence.** `004` will not let a receipt claim `VERIFIED`
unless a `verification_check` row says a read-back saw the change. That is
enforced by a trigger rather than by a service, because services get rewritten
and this is the claim the product is sold on.

## After applying

`002` seeds `table_registry` with every table in `public`, all `UNCLASSIFIED`,
which means invisible. Until somebody works through them the owner dashboard
shows nothing. That backlog is the work queue:

```sql
select * from public.table_registry_gaps;
```

Two constraints in `001` are added `NOT VALID` on purpose — they apply to every
future write while leaving the ~4,000 existing `entity` rows unchecked, so
applying cannot fail on data written before the rule existed. Validate them
only after the query in the file's comments comes back empty.

## What is deliberately not here

`apps` and `site_apps` are the previous generation's app store, keyed on
`site_id`, and both are empty. `007` supersedes them and leaves them alone.

`entity_modules` holds 37,847 rows and is not touched. `007` copies the part of
it that was a genuine choice — sort order and settings — into
`entity_module_preferences` and deliberately does not copy `enabled`, which was
written from a preset list rather than by anyone enabling anything.

`sql/capability_tables.sql` is a different meaning of the word "capability" —
business inventory, vessels and trips — and is unrelated to `003`. It still
carries its DO NOT RUN banner and this work does not change that.
