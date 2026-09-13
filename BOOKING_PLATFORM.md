# The booking platform

A business in this system can now sell trips, not just be listed. Charters,
parasailing, jet ski hire, cruises, tours, lessons, appointments, day passes —
all of it through one engine, switched on per business from the dashboard.

It is **optional**. A business that never opens the Bookings tab is unaffected:
nothing here runs for them, and no existing route changed behaviour.

---

## The one idea

**A vertical is a row, not a branch.**

There is no charter table, no parasail module and no `if (isJetSki)` anywhere
in the code. A fishing charter and a parasail flight differ in four things —
how the day is cut into slots, who counts against capacity, what it costs per
head, and what has to be signed first — and all four are columns.

`booking_templates` holds the starting values for each trade as data. Picking
one writes an ordinary product row plus its rates, extras and hours, and from
that moment the vertical has no further existence: the owner edits normal rows.

Adding "Horseback Rides" is an `INSERT`. It appears in the dashboard
immediately, with its own prices and hours, with no deploy.

If you find yourself about to write `if (template_id === '…')`, the field you
need is missing. Add the field.

### What the columns cover

`schedule_mode` — how a calendar is cut up:

| mode | what it means | who uses it |
| --- | --- | --- |
| `fixed_times` | departures at set clock times | charter, parasail, cruise |
| `duration_slots` | rolling slots of N minutes | jet ski, kayak, lesson, appointment |
| `date_range` | check-in to check-out | multi-day hire, lodging |
| `open_date` | a whole day, no time | day pass, admission |
| `request` | no calendar, an enquiry | custom trips, group quotes |

`capacity_mode` — what fills up:

| mode | what it means |
| --- | --- |
| `seats` | passengers share one departure (a 6-pack charter) |
| `units` | countable things (12 jet skis) |
| `exclusive` | one booking takes the whole slot (a private boat) |

Between them these cover every vertical seeded so far, and the ones that are
not seeded yet.

---

## The pieces

| file | what it is |
| --- | --- |
| `sql/booking_platform.sql` | the schema, plus the thirteen seeded verticals |
| `lib/bookingCore.js` | availability and pricing — pure functions, no I/O |
| `lib/stripeConnect.js` | Connect onboarding, destination charges, refunds |
| `lib/bookingWidget.js` | the customer-facing checkout, as one file |
| `routes/booking.js` | the API: owner, public, webhook |
| `scripts/test-booking.js` | 56 offline checks on the engine |
| `scripts/test-booking-routes.js` | 29 offline checks on the routes |

Dashboard side, in `Dashboards-users-`: `src/pages/Bookings.jsx` and
`src/booking/`.

---

## Money

**A browser posts quantities. The server posts back an amount.**

`POST /quote` and `POST /checkout` price the same cart through the same
function in `lib/bookingCore.js`, so what a customer is shown and what their
card is billed cannot drift. There is no request shape that lets a customer
name their own price — `scripts/test-booking-routes.js` asserts exactly that,
by posting a checkout with `total_amount: 1` and checking what got written.

Every calculation is in integer cents. `0.1 + 0.2` is a real bug in a payments
path and a per-person rate across six passengers is where it shows up.

`booking_line_items` records how each total was reached, so a charge disputed a
year later can still be explained.

### Payments

Connect **destination charges**: the platform creates the charge, Stripe
settles it into the business's own account, and the platform's cut rides along
as an `application_fee_amount`. Stripe pays the business out directly. The
platform never holds their money.

The cut comes from `platform_fee_rules`, resolved most-specific-first:
entity → template → global. A business negotiated to zero is a row.
`PLATFORM_FEE_PERCENT` is only the fallback when the table is empty.

#### Why this does not extend `routes/stripe.js`

That route asks businesses to paste their live `sk_live_…` secret key and
stores it encrypted. It works, and it is a standing liability: one stolen
encryption key is every business's Stripe account at once, and nothing about a
booking needs that much power.

A Connect account id is not a credential — it is useless without the platform
key that signs for it. Nothing stored by the new path can be stolen and spent.
The old route is left alone for whatever still calls it.

---

## Guards

**Owner routes** use `ownerRequired`. The slug comes from the session through
`entity_owners` and every query carries it — the repo's standing rule. Writes
go through an explicit column allow-list, so a field the API never offered
cannot be set by sending it.

**Public routes** (`/api/booking/public/:slug/…`) do name a slug in the path,
because a stranger has no session to resolve one from. That is safe because
they only read what a business publishes and only write a booking of the
customer's own. Nothing there can change a price, a schedule, or another
booking. Public payloads are explicit allow-lists rather than "the row minus a
few fields", so a column added later does not silently become public.

**The webhook** trusts the signature, not the payload — and refuses every event
when `STRIPE_WEBHOOK_SECRET` is unset rather than falling back to trusting it.
Every event id is claimed in `booking_webhook_events` before any work, so a
Stripe retry cannot charge or cancel twice.

### The race that matters

Checkout claims the seats as a **hold** before it asks Stripe for anything:

1. price the cart server-side
2. check the seats are still there
3. write the booking as a hold — this claims them
4. only then create the Stripe session

Two people racing for the last seat get one booking and one clear refusal,
instead of two charges and an apology. Abandoned holds expire by themselves
(`BOOKING_HOLD_MINUTES`, released lazily on the next read that cares).

---

## One calendar

Availability is computed from `booking_calendar`, which already collects
date-claims from every source this API has — its own checkouts, FareHarbor
syncs, iCal feeds, email-parsed reservations, manual blocks. A boat sold on
another platform is unavailable here too.

A claim carrying no `product_id` (an external sync that knows nothing about our
ids) counts against **everything**. That is the safe direction to be wrong in:
it can cost a booking, where the opposite double-books a boat.

---

## The front door

A booking API with no front door is a booking API nobody uses.

```html
<div id="gcr-book"></div>
<script src="https://<api>/api/booking/embed.js" data-slug="my-charters"></script>
```

Drops a working checkout into any site the business already has — Wix,
Squarespace, WordPress, their GCR listing. For a business with no site at all,
`/api/booking/page/:slug` is the same widget on a hosted page.

No build step, no framework, no card data: the card form is Stripe's hosted
checkout, one redirect away, which keeps PCI scope out of both this repo and
the business's own website.

---

## Checks

```
npm run test:booking    # 85 checks, no credentials or network
npm run verify          # everything, including the above
```

`test-booking.js` covers the arithmetic: pricing across every mode, capacity,
lead times, blackouts, resource conflicts, refund windows, fee precedence,
template instantiation.

`test-booking-routes.js` covers what arithmetic cannot, using a fake database
that records every query the handlers build — so it asserts on the *filters*,
not just the response. A handler that fetched the right rows while filtering on
the wrong slug would pass a response-shape test and fails this one.

Both suites have been confirmed to fail when the code is wrong: a seeded
rounding bug and a seeded cross-tenant leak were each caught.

---

## Not built yet

Honest list, in rough order of when it will be missed:

- **Waivers.** `requires_waiver` is stored and surfaced but nothing enforces a
  signature before departure. The `waivers` table already exists and
  `routes/platform.js` has a signing flow to borrow.
- **Balance collection.** A deposit booking records what is still owed and the
  dashboard shows it, but there is no "charge the rest" button — the business
  collects on the day.
- **Resource assignment.** `booking_resources` and the conflict checks are
  live, but the dashboard has no UI for assigning a boat to a booking; the API
  accepts `resource_id` today.
- **Rescheduling.** A customer can cancel from their link but not move a
  booking. `routes/platform.js` has a reschedule flow to model it on.
- **Owner calendar view.** `GET /calendar` returns every claim; nothing draws
  it yet — the Bookings tab is a list.
- **Per-product questions in the dashboard.** Templates seed them and the
  widget renders them; editing them needs a UI.
