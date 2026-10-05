# SQL apply order

Every file here is additive and safe to re-run (`npm run check:sql` refuses
anything that drops or deletes). Apply them to the live database **in this
order**, top to bottom. A file that is already applied can be applied again
without harm.

Nothing in this repo applies them for you. Run each one yourself, against the
database named in `CLAUDE.md`, after checking it is the right project.

## Prerequisites (may already be live; re-running is harmless)

| # | File | Why it comes first |
| - | ---- | ------------------ |
| 1 | `billing.sql` | plans, subscriptions, usage |
| 2 | `store.sql` | store items and installs (references `billing_plan`) |
| 3 | `ghost_nodes.sql` | the device list |
| 4 | `business_claims_entity_slug.sql` | `business_claims.entity_slug` |

## NEXT GENT business link (plan build step 4)

| # | File | What it adds |
| - | ---- | ------------ |
| 5 | `business_mcp_tokens.sql` | the business token table — **not yet on the live database** |
| 6 | `ghost_mcp_tokens.sql` | Ghost MCP credentials (needs `ghost_nodes.sql`) — **not yet on the live database** |
| 7 | `nextgent_link.sql` | `company_links`, `platform_admins.paperclip_user_id`, token `permissions` / `install_id` / `company_id`, `business_claims.paperclip_*` (needs 4 and 5) |
| 8 | `nextgent_installs.sql` | `nextgent_installs` (scoped installs, routine webhooks) |
| 9 | `nextgent_claims.sql` | `claim_codes` |
| 10 | `nextgent_notify.sql` | `owner_notify_settings`, `owner_notifications` |
| 11 | `nextgent_billing.sql` | item prices, Stripe ids, non-payment clock, `billing_item_charges`, `billing_usage_credits` (needs 1 and 2) |

## NEXT GENT part 2 (plan build steps 7, 9, 12)

| # | File | What it adds |
| - | ---- | ------------ |
| 12 | `nextgent_prices.sql` | `billing_item_prices` (prices Paperclip's store sets, CONTRACT §12) |
| 13 | `nextgent_phone.sql` | phone verification codes; `business_phone_numbers` (Phone Agent numbers and their texting registration), forwarding codes, live conversations, AI keys |
| 14 | `nextgent_messages.sql` | `message_threads`, `business_messages`, `message_consent` (messages.send, the Messages screen) |
| 15 | `nextgent_automations.sql` | `automation_waits`, `owner_automation_drafts`; needs `automations.sql` and `booking_ingestion_tables.sql` |
| 15a | `nextgent_scheduler_state.sql` | `scheduler_state`: the booking completion check's first-run watermark. Until it is applied the check completes nothing |
| 15b | `nextgent_stripe_events.sql` | `stripe_webhook_events`: every Stripe event id acted on, so an event delivered twice (either webhook path, or a retry) is processed once |
| 16 | `nextgent_intake.sql` | forwarding confirmation rules (seeded) and confirmations, `intake_known_senders`, `email_parser_log.intake_state`, `payments_detected` |
| 17 | `nextgent_nodes.sql` | computer pairing (device flow), remote-view sessions, task id and receipt columns on `ghost_node_requests` (needs `ghost_nodes.sql`) |
| 18 | `nextgent_google_push.sql` | Google push queue and state, fact sources (seeded), attribute map, source ranks (seeded), `fact_observations` |

## NEXT GENT apps (app engine, CONTRACT §14)

| # | File | What it adds |
| - | ---- | ------------ |
| 18a | `nextgent_apps.sql` | `app_records` (an app's own records) — needs 8. Its `business_app_instances` DDL is superseded by 18b and kept only as a comment |
| 18b | `nextgent_entity_modules.sql` | `entity_modules.managed_by / install_id / company_id / version / render_mode / public_label / updated_at`: the runtime projection of installed apps is one `entity_modules` row per install (manifest, settings and the public flag in `settings`). Replaces `business_app_instances`. Apply **before** Paperclip sends app installs: an install answers 503 until it is applied |

## Step 5: business facts the apps bind to (DECISIONS #44, #49)

| # | File | What it adds |
| - | ---- | ------------ |
| 18c | `nextgent_business_contacts.sql` | `entity_leads` (enquiries, contract `leads.items`) and `entity_customers` (the per-business customer record, contract `customers.items`), both with the SPEC §6.6 provenance columns. Until applied the two contracts answer "not a business section" |
| 18d | `nextgent_business_currency.sql` | `entity.currency` (nullable; contract `business.currency` reads `DEFAULT_CURRENCY` when null). Until applied the column is absent, so every business reads as `DEFAULT_CURRENCY` and the owner cannot set one |
| 18e | `nextgent_messages_app_channel.sql` | widens the `message_threads` / `business_messages` channel checks with `'app'`, so a visitor's submission to an installed app lands in Messages (needs 14). Until applied, submissions are still stored as records; the inbox row is refused and logged |

After step 11, add your own Paperclip user id to `platform_admins.paperclip_user_id`
for your admin row, so `role = instance_admin` tokens are honoured.

## One copy of each thing (the duplication audit)

Apply after everything above. Each moves data that two places held into the
one kept place; the old place is left untouched until the "Later" step.

| # | File | What it does |
| - | ---- | ------------ |
| 19 | `nextgent_prices_fold.sql` | copies `store_items.price_cents / price_interval / stripe_price_id` into `billing_item_prices` (needs 11 and 12). Apply **before** deploying the code that stops reading the `store_items` prices, or priced items read as free until it runs |
| 20 | `nextgent_claims_codes.sql` | `claim_codes.code_hash` may be empty: a claim's code is now a phone code (`phone_verification_codes`, purpose `claim:<id>`). Apply **before** deploying, or new claims answer 503 |
| 21 | `nextgent_consent_fold.sql` | copies `booking_opt_ins.sms_consent` and `bookings.sms_consent` yeses into `message_consent`, the only place consent is read now (needs 14). Set its default country code to `TELEPHONY_DEFAULT_COUNTRY_CODE` first. Apply **before** deploying, or customers who said yes on an older form are not texted until it runs |
| 22 | `nextgent_update_links.sql` | `update_links.passcode_attempts`, the wrong-guess count behind the update link's passcode lock (routes/update-link.js). Independent of the rows above; until it is applied the passcode check holds but guesses are not counted |

### Later (not a file here yet)

`npm run check:sql` refuses any file that drops a column, so these wait for a
deliberate, reviewed one-off once the step above is applied and checked:

- drop `store_items.price_cents`, `store_items.price_interval`,
  `store_items.stripe_price_id` (nothing reads them after step 19).

## Everything else

The other files (`capability_*`, `automations.sql`, `composio_connections.sql`,
`menu_normalization.sql`, `search_indexes.sql`, …) are independent of the list
above and keep their own notes at the top of each file.
