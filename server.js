// Cache buster: 2026-06-01T02
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Fail-safe route mount: a broken/WIP route file is skipped with a warning
// instead of crashing the entire API on boot. The loader thunk MUST contain a
// literal require('./...') string so Vercel's bundler statically traces and
// includes the route file (a dynamic require(variable) is NOT bundled → 404).
function mount(path, loader) {
  try {
    app.use(path, loader());
  } catch (e) {
    console.error(`[mount skipped] ${path}: ${e.message}`);
  }
}

app.get('/', (req, res) => res.json({ status: 'GCR API running', version: '2026-06-17b', endpoints: 'api/gcr/*, api/admin/*, api/dashboard/*, api/public/*, api/auth/*, api/user/*, api/site/*, api/menu-editor/*, api/tourist/*, api/tourist-auth/*' }));

// Auth
mount('/api/auth', () => require('./routes/auth'));

// GCR & Admin
mount('/api/gcr', () => require('./routes/gcr'));
mount('/api/admin', () => require('./routes/admin'));

// Dashboard (business owner) — TODO: has missing module dependencies
mount('/api/dashboard', () => require('./routes/dashboard'));

// Public
mount('/api/public', () => require('./routes/public'));

// User
mount('/api/user', () => require('./routes/user'));

// Site
mount('/api/site', () => require('./routes/site'));

// Menu
mount('/api/menu-editor', () => require('./routes/menu-editor'));
mount('/api/menu-edit', () => require('./routes/menu-edit'));
mount('/api/simple', () => require('./routes/simple-menu-edit'));

// Business sign-up — phone, six-digit code, account. A SEPARATE system from
// routes/tourist-auth.js below: different product, different account model,
// no shared code. Changing one must never move the other.
mount('/api/business-auth', () => require('./routes/business-auth'));

// The approval gate for those sign-ups. Nothing self-created goes public
// until an admin says so.
mount('/api/admin/signups', () => require('./routes/admin-signups'));

// Tourist
mount('/api/tourist-auth', () => require('./routes/tourist-auth'));
mount('/api/tourist', () => require('./routes/tourist'));
mount('/api/tourist/groups', () => require('./routes/tourist-groups'));

// Admin tourists
mount('/api/admin/tourists', () => require('./routes/admin-tourists'));

// Setup questions
mount('/api/admin/setup-questions', () => require('./routes/setup-questions'));

// Admin view over the universal booking engine. Same tables as /api/platform,
// but scoped by an admin token across every business instead of resolving one
// business from entity_owners. Every route is adminRequired.
mount('/api/admin/platform', () => require('./routes/admin-platform'));

// Composio connections — the tool catalog and which business connected what.
mount('/api/admin/connections', () => require('./routes/composio'));

// Admin settings, business leads, guest photos, category cards. Mounted at
// /api/admin alongside routes/admin.js — Express runs both routers in order,
// so these paths are additive and nothing in admin.js is shadowed.
mount('/api/admin', () => require('./routes/admin-settings'));

// One business seen the way its own dashboard would show it: every slug-keyed
// table that actually has rows for it, discovered from the schema per request.
// No table list lives in code, so a new table with data becomes a new section
// with no deploy.
mount('/api/admin/gcr', () => require('./routes/business-profile'));

// Read-only analytics over behaviour the front end already records: per
// business and across the platform. Writes nothing, invents nothing, and
// reports what is NOT tracked alongside what is.
mount('/api/admin/analytics', () => require('./routes/admin-analytics'));

// Read a business's own links and propose real column values for any
// slug-keyed table. Proposes only — nothing is written without review.
mount('/api/admin/gcr', () => require('./routes/ingest'));

// Intake: a business submits its links, every listening webhook is told, and
// the operator works the queue. The public POST /api/intake only creates a
// request; reading and updating the queue is admin-only.
mount('/api/intake', () => require('./routes/intake'));
mount('/api/admin/intake', () => require('./routes/intake'));

// Text the dashboard a question, get an answer from real data. A SEPARATE
// system from routes/sms.js — that one is the customer pipeline (tourist
// signup, staff commands, blasts) and is untouched by this. Brevo only, no
// Twilio, and the allowlist is the authentication.
mount('/api/dashboard-sms', () => require('./routes/dashboard-sms'));

// The embeddable availability calendar a business drops into its own website,
// plus the JSON it reads. Public and unauthenticated by design — it runs on
// anonymous visitors' browsers on other people's domains — and returns only
// counts and statuses, never a guest, an email or a booking row.
mount('/api/embed', () => require('./routes/embed'));

// Apps & Modules
mount('/api/apps', () => require('./routes/apps'));
//mount('/api/modules', () => require('./routes/modules')); // UNMOUNTED: backing tables don't exist in the live DB — booking types now run through the ONE universal engine (/api/platform). Remount only after a real slug-keyed table exists.
mount('/api/platform', () => require('./routes/platform'));

// Google Business
//mount('/api/google-business', () => require('./routes/google-business')); // UNMOUNTED: backing tables don't exist in the live DB — booking types now run through the ONE universal engine (/api/platform). Remount only after a real slug-keyed table exists.
// mount('/api/dashboard/google-business', () => require('./routes/google-business')); // dashboard disabled

// SMS
mount('/api/sms', () => require('./routes/sms'));

// QR & Redirects
mount('/api/qr', () => require('./routes/qr'));
mount('/api/ar-hunts', () => require('./routes/ar-hunts'));
mount('/api/links', () => require('./routes/links'));

// Update links
mount('/api/update', () => require('./routes/update-link'));
mount('/update', () => require('./routes/update-link'));

// Payments — Stripe and Square
mount('/api/stripe', () => require('./routes/stripe'));
mount('/api/square', () => require('./routes/square'));
mount('/api/webhooks', () => require('./routes/webhooks'));

// Booking types
mount('/api/availability', () => require('./routes/availability'));
//mount('/api/boat-rental', () => require('./routes/boat-rental')); // UNMOUNTED: backing tables don't exist in the live DB — booking types now run through the ONE universal engine (/api/platform). Remount only after a real slug-keyed table exists.
//mount('/api/charter', () => require('./routes/charter')); // UNMOUNTED: backing tables don't exist in the live DB — booking types now run through the ONE universal engine (/api/platform). Remount only after a real slug-keyed table exists.
//mount('/api/rides', () => require('./routes/rides')); // UNMOUNTED: backing tables don't exist in the live DB, and this used the legacy site_id convention. Superseded by /api/transportation below (entity_slug-keyed, real tables).
mount('/api/transportation', () => require('./routes/transportation'));
//mount('/api/photographer', () => require('./routes/photographer')); // UNMOUNTED: backing tables don't exist in the live DB — booking types now run through the ONE universal engine (/api/platform). Remount only after a real slug-keyed table exists.
mount('/api/integrations/fareharbor', () => require('./routes/fareharbor'));

// Live photo
mount('/api/live-photo', () => require('./routes/live-photo'));

// AI Provider
mount('/api/ai-provider', () => require('./routes/ai-provider'));

// Reviews, Team, Gallery, FAQs, Blog, Bookings — Mini-site features
mount('/api/reviews', () => require('./routes/reviews'));
mount('/api/team', () => require('./routes/team'));
mount('/api/gallery', () => require('./routes/gallery'));
mount('/api/faqs', () => require('./routes/faqs'));
mount('/api/blog', () => require('./routes/blog'));
mount('/api/bookings', () => require('./routes/bookings'));
mount('/api/analytics', () => require('./routes/analytics'));

// Artists & Live Music
mount('/api/artists', () => require('./routes/artists'));
mount('/api/artist-bookings', () => require('./routes/artist-bookings'));
mount('/api/cooperatives', () => require('./routes/cooperatives'));
mount('/api/goals', () => require('./routes/goals'));
mount('/api/webhooks', () => require('./routes/email-webhook'));
mount('/api/meta-webhook', () => require('./routes/meta-webhook'));

// Messaging
//mount('/api/messaging', () => require('./routes/messaging')); // UNMOUNTED: backing tables don't exist in the live DB — booking types now run through the ONE universal engine (/api/platform). Remount only after a real slug-keyed table exists.

// Rentals & Bookings
mount('/api/rentals', () => require('./routes/rentals'));
mount('/api/services', () => require('./routes/services'));

// WhatsApp, Voice Notes, OCR, DNS
//mount('/api/whatsapp', () => require('./routes/whatsapp')); // UNMOUNTED: backing tables don't exist in the live DB — booking types now run through the ONE universal engine (/api/platform). Remount only after a real slug-keyed table exists.
mount('/api/voice-notes', () => require('./routes/voice-notes'));
mount('/api/email-parser', () => require('./routes/email-parser'));
mount('/api/email-parser', () => require('./routes/email-parser'));
mount('/api/deals', () => require('./routes/deals'));
mount('/api/ocr', () => require('./routes/ocr'));
mount('/api/verify-dns', () => require('./routes/verify-dns'));
mount('/api/gcr/deep-crawl', () => require('./routes/gcr/deep-crawl'));
mount('/api/gcr/admin', () => require('./routes/rehost-photos'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`GCR API listening on port ${PORT}`));

