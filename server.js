// Cache buster: 2026-06-01T02
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

/* ── who is allowed to call this API from a browser ───────────────────────
 *
 * This was `origin: '*'`, which let any page on any domain make authenticated
 * requests from a visitor's browser. The list below comes from an env var so a
 * new white-label domain is a config change rather than a deploy.
 *
 *   CORS_ORIGINS=https://a.example.com,https://b.example.com
 *
 * Requests with no Origin header — server-to-server, curl, Twilio and Stripe
 * webhooks, health checks — are allowed through. CORS is a browser mechanism;
 * refusing them would break every integration without protecting anything, as
 * anything that can omit an Origin header can also forge one.
 */
// The origins that exist today, baked in so this file is correct with no
// configuration at all. CORS_ORIGINS adds to this list; it does not replace
// it, so forgetting to set it cannot take the dashboards down.
//
// Per-deploy preview hostnames are deliberately absent and cannot be added:
// Vercel mints a new one on every push. Test against the stable domains.
const DEFAULT_ORIGINS = [
    'https://gulfcoastradar.com',
    'https://www.gulfcoastradar.com',
    'https://dashboard.gulfcoastradar.com',
    // The business dashboard (Vercel project: dashboards-users)
    'https://dashboards-users.vercel.app',
    'https://dashboards-users-cyber-check.vercel.app',
    // The admin dashboard (Vercel project: admin-dashboard-main)
    'https://admin-dashboard-main.vercel.app',
    'https://admin-dashboard-main-cyber-check.vercel.app',
    // The public tourist site
    'https://gcr-unified.vercel.app',
];

const allowedOrigins = new Set(
    (process.env.CORS_ORIGINS || '')
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean)
        .concat(DEFAULT_ORIGINS),
);

// Local development hosts, only when this is not a production deploy.
const allowLocalhost = process.env.VERCEL_ENV !== 'production' && process.env.NODE_ENV !== 'production';

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        const normalized = origin.replace(/\/+$/, '');
        if (allowedOrigins.has(normalized)) return callback(null, true);
        if (allowLocalhost && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized)) {
            return callback(null, true);
        }
        // Not an error — an error here becomes a 500. Refusing to send the
        // header is what makes the browser block the response, which is the
        // correct outcome and leaves non-browser callers unaffected.
        return callback(null, false);
    },
    credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

/* ── rate limits on the two doors that cost money ─────────────────────────
 *
 * Every phone-verification request spends a Twilio message. Both sign-up
 * systems are public by necessity, so without a limit a script can run up a
 * real bill and burn the numbers it targets.
 *
 * Keyed per IP. Trust the proxy first, or every request behind Vercel's edge
 * looks like it comes from the same address and the limit locks out the world.
 */
app.set('trust proxy', 1);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_LIMIT || 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts — wait a few minutes and try again.' },
});

app.use('/api/business-auth', authLimiter);
app.use('/api/tourist-auth', authLimiter);

/* ── and on the one door that is open to everybody ────────────────────────
 *
 * /api/mcp/public takes no token by design — it serves data already on the
 * public website. That makes it the only unauthenticated endpoint here that
 * runs real queries, so it gets a ceiling instead of a password.
 *
 * ── Why this cannot be keyed on the IP alone ─────────────────────────────
 *
 * The caller is usually not the visitor. A hosted voice agent relays every
 * conversation from its own servers, so a thousand people talking at once
 * arrive from a handful of addresses — and a per-IP ceiling would throttle the
 * whole platform at a dozen simultaneous conversations while the visitors sat
 * there hearing nothing.
 *
 * So the bucket is the caller's own credential where there is one: each
 * signed-in visitor and each guest id gets its own budget no matter whose
 * servers relayed the request. Only traffic with no identity at all falls back
 * to the IP, and that bucket is large, because it is shared by everyone behind
 * one hotel's wifi as well as by a scraper.
 *
 * The limit exists to stop somebody walking the entire directory. It is not
 * here to ration a conversation.
 */
const publicMcpLimiter = rateLimit({
    windowMs: 60 * 1000,
    // 600/min was set against the cost of a chat turn. read_business is not a
    // chat turn: it calls buildFullEntity, which is 72 queries. 600 of those a
    // minute is ~43,000 queries/min from one caller — past what the database's
    // CPU can serve, at which point every other connection times out. 60 keeps
    // a conversation comfortable and puts the ceiling below the damage line.
    // Raise it with PUBLIC_MCP_RATE_LIMIT once read_business is cheaper.
    max: Number(process.env.PUBLIC_MCP_RATE_LIMIT || 60),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const credential = (req.headers.authorization || '').trim()
            || String(req.headers['x-guest-id'] || '').trim();
        // Hashed, so a token never reaches the limiter's key store in the clear.
        if (credential) return `id:${crypto.createHash('sha256').update(credential).digest('hex').slice(0, 32)}`;
        return `ip:${req.ip}`;
    },
    message: { error: 'Too many requests — slow down and try again shortly.' },
});

app.use('/api/mcp/public', publicMcpLimiter);
app.use('/api/mcp/business', publicMcpLimiter);

// Fail-safe route mount: a broken/WIP route file is skipped with a warning
// instead of crashing the entire API on boot. The loader thunk MUST contain a
// literal require('./...') string so Vercel's bundler statically traces and
// includes the route file (a dynamic require(variable) is NOT bundled → 404).
const mountedRouters = [];

function mount(path, loader) {
  try {
    app.use(path, loader());
    mountedRouters.push(path);
  } catch (e) {
    console.error(`[mount skipped] ${path}: ${e.message}`);
  }
}

// The deployment's own identity, read from the build rather than typed here.
// This used to return a hand-written version string and a hand-written list of
// endpoints, both of which went stale the moment anything moved — which is why
// a current deployment looked abandoned from the root URL.
app.get('/', (req, res) => res.json({
  status: 'GCR API running',
  commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
  routers: mountedRouters.length,
  endpoints: mountedRouters,
}));

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

// Everything the business dashboard reads or writes about its own business.
// Every handler resolves the slug from the session via entity_owners, so no
// request can name a business. This is what replaced the dashboard's direct
// PostgREST access — and with it, the anon key in a public browser bundle.
mount('/api/business', () => require('./routes/business-data'));

// One agent that knows every business. The public directory as MCP tools —
// search, full details, cheapest-first prices, today's availability, side-by-
// side comparison — so a single voice agent on one phone number, or one web
// chat, can answer for any business on the platform.
//
// Open and read-only by design: everything it returns is already on the public
// site, so a token would protect nothing and would stop it scaling. The tools
// come from lib/conciergeTools.js, the same five routes/tourist.js already
// runs its chat on.
//
// Mounted before /api/mcp so the more specific path wins.
//
// ── The kill switch ──────────────────────────────────────────────────────
//
// These two mounts are the only unauthenticated doors that run real queries,
// and read_business costs 72 of them per call (buildFullEntity). At the
// default 600/min ceiling one caller may issue ~43,000 queries a minute,
// which is enough to saturate the database's CPU and time out every other
// connection — including the dashboard's, which makes it look like the whole
// platform is down rather than like one endpoint is busy.
//
// Set MCP_PUBLIC_ENABLED=false in Vercel to take both doors off the internet
// without a code change. The token-scoped /api/mcp below is unaffected: it is
// authenticated, so it is not the one that can be walked by a stranger.
const mcpPublicEnabled = String(process.env.MCP_PUBLIC_ENABLED ?? 'true').toLowerCase() !== 'false';

if (mcpPublicEnabled) {
mount('/api/mcp/public', () => require('./routes/mcp-public'));
} else {
    console.warn('[mcp] /api/mcp/public and /api/mcp/business are DISABLED (MCP_PUBLIC_ENABLED=false)');
    const off = (_req, res) => res.status(503).json({ error: 'Public MCP is temporarily disabled.' });
    app.all('/api/mcp/public', off);
    app.all('/api/mcp/public/*', off);
    app.all('/api/mcp/business/*', off);
}

// The same tools, attached to one business by the slug in the URL:
//
//     /api/mcp/business/flora-bama
//
// A business's own agent with nothing to provision — standing one up for every
// business on the platform is a string concatenation, not a token minted and
// rotated a thousand times. Reads only, same public data. Writing is what
// /api/mcp and its tokens are for.
if (mcpPublicEnabled) {
mount('/api/mcp/business/:slug', () => require('./routes/mcp-public').pinned);
}

// The same data, spoken to instead of clicked on. An MCP server so an outside
// AI assistant — Grok, or any other MCP client — can read and edit one
// business's sections in words.
//
// It is deliberately NOT a database MCP server. It calls the same schema
// discovery, table allow-list and column filter as the router above
// (lib/businessTables.js), so the rule holds: only this API touches Postgres,
// including when the caller is a model. Which business it acts as comes from
// the token, never from the request.
mount('/api/mcp', () => require('./routes/mcp'));

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

// The same App Store, scoped to one business. Resolves the slug from
// entity_owners rather than the path, so a business connects its own tools and
// cannot reach anyone else's. Every route above is adminRequired; without this
// a business could not connect anything at all.
mount('/api/connections', () => require('./routes/composio').ownerRouter);

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
//mount('/api/apps', () => require('./routes/apps')); // UNMOUNTED: superseded by routes/composio.js (the App Store). Both backing tables are empty, and the code no longer matches them — line 12 filters on `active`, which the apps table calls `status`, and line 45 inserts a `provider` field site_apps has no column for. Replaced, not broken: do not repair it.
//mount('/api/modules', () => require('./routes/modules')); // UNMOUNTED: backing tables don't exist in the live DB — booking types now run through the ONE universal engine (/api/platform). Remount only after a real slug-keyed table exists.
mount('/api/platform', () => require('./routes/platform'));

// Google Business Profile. Remounted: oauth_tokens now exists and is keyed by
// entity_slug, the routes resolve the business from entity_owners instead of
// the dead site_id convention, and the OAuth state is signed rather than
// carrying a slug anyone could edit in a query string.
//
// This is the one integration Composio does not cover, and the only one that
// carries proof: Google made the business verify its address before it could
// control the profile, so connecting is evidence the business is real.
mount('/api/google-business', () => require('./routes/google-business'));

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

