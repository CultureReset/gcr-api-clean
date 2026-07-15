# CANONICAL DATABASE — Single Source of Truth

> **STOP.** Before creating any table, pointing an app at a database, or writing
> DB code, read this file. There is exactly ONE live database and ONE data model.
> Duplicate databases, duplicate deployments, and duplicate tables are the root
> cause of the "it shows right, then it's wrong an hour later" problem. Do not add
> to the sprawl.

## The one database

| | |
|---|---|
| **Name** | `cyber check` |
| **Supabase ref** | `mkepugvdlktfsossumox` |
| **URL** | `https://mkepugvdlktfsossumox.supabase.co` |
| **Selected in code by** | `GCR_SUPABASE_URL` / `GCR_SUPABASE_SERVICE_KEY` (API), `VITE_SUPABASE_URL` (frontend) |

Confirmed canonical because it holds the full, current data set and is what the
live public site and the linked Supabase project already use:

> entity **3428** · entity_photos **19866** · entity_hours **13805** ·
> menu_items **9227** · menu_sections **1585** · entity_reviews **10481** ·
> entity_tags **2496** · entity_amenities **721** · entity_modules **2050** ·
> entity_sections **287** · entity_events **82** · entity_specials **30** (2026-07)

### Databases that must NEVER be used again (stale/abandoned copies)
| Ref | Name | Why it's dead |
|---|---|---|
| `xbptmkpbiqzvxptjkfoi` | launch gcr | Old partial snapshot (May 2026): 2758 entities, **0 menu items, 0 reviews** |
| `adpnhipmdefutkzzltbs` | gulf coast radar | Different older schema, no `entity_reviews` |
| `lvmsmjlallptylonscat` | CultureReset's Project | Unrelated, no `entity` table |

If any deployed app or script points at these, it is a bug. Repoint it at
`mkepugvdlktfsossumox` (via env var, not a hardcoded literal).

## The data model — everything keys off `entity.slug`

`entity` is the parent (one row per business/listing, ~178 columns). Every
satellite table links back via a **`entity_slug` text column** (NOT a numeric FK).
Menu/drink/section items additionally link to their section via `section_id` (uuid).

```
entity (id uuid, slug text — the join key everything uses)
 ├─ entity_hours          (entity_slug, day_of_week int, opens_at, closes_at, is_closed)
 ├─ entity_photos         (entity_slug, url, image_path, is_cover, sort_order, caption, ...)
 ├─ entity_tags           (entity_slug, tag_name, tag_category)
 ├─ entity_amenities      (entity_slug, amenity, category, sort_order)
 ├─ entity_events         (entity_slug, event_name, event_date, start_time, ...)
 ├─ entity_specials       (entity_slug, special_name, discount_*, days, ...)
 ├─ entity_reviews        (entity_slug, reviewer_name, rating, title, body, approved, ...)
 ├─ entity_sections       (entity_slug, section_type, section_name, sort_order, layout, ...)
 │   └─ entity_section_items (section_id → entity_sections.id, entity_slug, item_name, ...)
 ├─ entity_modules        (entity_slug, module_key, enabled, settings jsonb)   [catalog: module_catalog]
 ├─ menu_sections         (entity_slug, section_name, sort_order, ...)
 │   └─ menu_items        (section_id → menu_sections.id, entity_slug, item_name, price, ...)
 ├─ drink_sections        (entity_slug, ...)
 │   └─ drink_items       (section_id → drink_sections.id, entity_slug, item_name, price, ...)
 ├─ happy_hour_sections / happy_hour_items
 ├─ offerings / offering_prices
 ├─ entity_faqs, entity_policies, entity_team_members, entity_perfect_for, entity_about_bullets
 └─ entity.entity_subtype → subtype_taxonomy (drives which GCR page the listing appears on)

Platform-level: gcr_claims, gcr_ads, gcr_coupons, gcr_page_views, qr_codes, module_catalog
```

## DEAD / DUPLICATE tables — do NOT read or write these

Leftovers from earlier abandoned designs and from a separate legacy "mini-site /
business-owner" subsystem (keyed by `site_id`) whose names collide with the real
GCR model. The GCR code path does not use these; a few legacy routes still do
(see CONSOLIDATION_PLAN.md). Do not use the left column for GCR work.

| Dead table | Use instead |
|---|---|
| `businesses`, `business_details` | `entity` |
| `business_photos` | `entity_photos` |
| `business_hours` | `entity_hours` |
| `photos` | `entity_photos` |
| `events` | `entity_events` |
| `specials` | `entity_specials` |
| `reviews` | `entity_reviews` |
| `menu_details`, `gcr_menu_items` | `menu_sections` + `menu_items` |
| `locations` | `entity.address_line_1 / city / state / zip / latitude / longitude` |

Plus ~150 empty vertical/spec tables never populated. A confirmed drop/archive
list must be approved by the owner before any DDL is run.
