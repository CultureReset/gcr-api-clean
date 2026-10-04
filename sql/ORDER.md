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

After step 11, add your own Paperclip user id to `platform_admins.paperclip_user_id`
for your admin row, so `role = instance_admin` tokens are honoured.

## Everything else

The other files (`capability_*`, `automations.sql`, `composio_connections.sql`,
`menu_normalization.sql`, `search_indexes.sql`, …) are independent of the list
above and keep their own notes at the top of each file.
