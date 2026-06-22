// ============================================================
// Module / App Store API
// Manages which apps a business has installed from the marketplace
//
// SQL — run in CyberCheck DB:
//
// CREATE TABLE IF NOT EXISTS module_manifest (
//   id              text PRIMARY KEY,
//   name            text NOT NULL,
//   description     text,
//   category        text,
//   icon            text,
//   is_core         boolean DEFAULT false,
//   price_monthly   numeric DEFAULT 0,
//   js_path         text,
//   config_schema   jsonb,
//   sort_order      int DEFAULT 0,
//   active          boolean DEFAULT true
// );
//
// CREATE TABLE IF NOT EXISTS user_modules (
//   id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   site_id         text NOT NULL,
//   module_id       text REFERENCES module_manifest(id),
//   installed_at    timestamptz DEFAULT now(),
//   config          jsonb DEFAULT '{}',
//   is_active       boolean DEFAULT true,
//   show_on_public  boolean DEFAULT true,
//   sort_order      int DEFAULT 0,
//   UNIQUE(site_id, module_id)
// );
//
// -- Seed module_manifest (run after CREATE TABLE):
// INSERT INTO module_manifest (id,name,description,category,icon,is_core,price_monthly,js_path,sort_order) VALUES
// -- CORE (always on)
// ('overview','Overview','Dashboard home & quick stats','core','📊',true,0,'overview.js',0),
// ('profile','Business Profile','Name, hours, contact, location','core','🏢',true,0,'profile.js',1),
// ('media','Photos & Media','Upload and manage your photos','core','📸',true,0,'media.js',2),
// ('customers','Customers','Customer list and contact history','core','👥',true,0,'customers.js',3),
// ('analytics','Analytics','Views, clicks, and traffic','core','📈',true,0,'analytics.js',4),
// ('billing','Billing & Plan','Subscription and payment settings','core','💳',true,0,'billing.js',5),
// ('connections','Integrations','Connect Stripe, Square, and more','core','🔗',true,0,'connections.js',6),
// ('domain','Custom Domain','Your own domain name','core','🌐',true,0,'domain.js',7),
// ('publish','Publish','Go live and manage visibility','core','🚀',true,0,'publish.js',8),
// ('theme','Theme & Branding','Colors, fonts, logo','core','🎨',true,0,'theme.js',9),
// ('seo','SEO','Search engine optimization','core','🔍',true,0,'seo.js',10),
// -- BOOKING
// ('bookings','Bookings','General booking management calendar','booking','📅',false,0,'bookings.js',20),
// ('photographer-booking','Photographer Booking','Service-based session booking with deposit, schedule, and model release','booking','📷',false,0,'photographer-booking.js',21),
// ('charter-booking','Fishing Charter Booking','Full charter booking with departure times, waiver, and deposit','booking','🎣',false,0,'charter-booking.js',22),
// ('boat-rental','Boat Rental','Hourly, half-day, full-day, and multi-day rentals','booking','⛵',false,0,'boat-rental.js',23),
// ('rides-dispatch','Rides & Taxi Dispatch','SMS lead dispatch with bidding and Stripe payment links','booking','🚗',false,0,'rides.js',24),
// ('appointments','Appointments','Staff-based appointment scheduling','booking','🗓️',false,0,'appointments.js',25),
// ('availability','Availability','Manage open slots and booking capacity','booking','✅',false,0,'availability.js',26),
// ('waitlist','Waitlist','Collect and manage a customer waitlist','booking','⏳',false,0,'waitlist.js',27),
// ('waivers','Waivers','Digital liability waivers for any service','booking','✍️',false,0,'waivers.js',28),
// -- CONTENT
// ('menu','QR Menu','Digital menu with QR code, categories, and photos','content','🍽️',false,0,'menu.js',40),
// ('events','Events','Upcoming events, ticketing, and promotions','content','🎉',false,0,'events.js',41),
// ('specials','Daily Specials','Happy hour, daily deals, and promotions','content','⭐',false,0,'specials.js',42),
// ('faq','FAQ','Frequently asked questions for your customers','content','❓',false,0,'faq.js',43),
// ('pages','Custom Pages','Build custom pages for your site','content','📄',false,0,'pages.js',44),
// ('qr-codes','QR Codes','Generate QR codes for menus, links, and forms','content','📲',false,0,'qr-codes.js',45),
// ('site-editor','Site Editor','Drag-and-drop website sections','content','🖥️',false,0,'site-editor.js',46),
// ('social','Social Links','Link your social media profiles','content','📱',false,0,'social.js',47),
// -- COMMERCE
// ('inventory','Inventory','Track stock, rentals, and equipment','commerce','📦',false,0,'inventory.js',60),
// ('addons','Add-ons & Extras','Upsell items on bookings','commerce','➕',false,0,'addons.js',61),
// ('coupons','Coupons & Discounts','Promo codes and discount offers','commerce','🎟️',false,0,'coupons.js',62),
// ('staff','Staff Management','Team members, roles, and schedules','commerce','👤',false,0,'staff.js',63),
// ('reviews','Reviews','Customer reviews and reputation management','marketing','⭐',false,0,'reviews.js',64),
// ('messaging','Messaging','SMS and email customer communication','marketing','💬',false,0,'messaging.js',65),
// -- AI & AUTOMATION
// ('ai-assistant','AI Assistant','AI-powered content, descriptions, and insights','ai','''🤖''',false,0,'ai-assistant.js',80),
// ('wavegent','WaveAgent AI','AI agent for automated customer interactions','ai','🌊',false,29,'wavegent-tab.js',81),
// ('data-sync','Data Sync','Keep data in sync across all your tools','ai','🔄',false,0,'data-sync.js',82),
// ('csv-import','CSV Import','Bulk import customers, products, or menus','ai','📊',false,0,'csv-import-system.js',83),
// -- INTEGRATIONS
// ('fareharbor','FareHarbor','Sync availability from FareHarbor in real time','integration','🌊',false,0,'fareharbor.js',100),
// ('square-pos','Square POS','Connect Square for payments and inventory','integration','◻️',false,0,'square.js',101),
// ('google-business','Google Business','Sync with Google Business Profile','integration','🔵',false,0,'google-business.js',102),
// ('availability-search','Discovery Search','Appear in the availability search engine for your region','discovery','🔎',false,0,'availability.js',120),
// ('gcr-directory','GCR Directory','Get listed on the Gulf Coast Radar discovery platform','discovery','📍',false,0,'gcr.js',121),
// ('trip-swipe','Trip Swipe','Appear in Trip Swipe vacation discovery feed','discovery','✈️',false,0,'trip-swipe.js',122)
// ON CONFLICT (id) DO NOTHING;
// ============================================================

const express    = require('express');
const { authRequired } = require('../middleware/auth');
const supabase   = require('../db');
const router     = express.Router();

// ── Public: list all available modules ───────────────────────
router.get('/available', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('module_manifest')
      .select('*')
      .eq('active', true)
      .order('sort_order');
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: get installed modules for a site ────────────────────
router.get('/installed', authRequired, async (req, res) => {
  try {
    const { site_id } = req.query;
    const { data, error } = await supabase
      .from('user_modules')
      .select('*, module_manifest(*)')
      .eq('site_id', site_id)
      .eq('is_active', true)
      .order('sort_order');
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: install a module ────────────────────────────────────
router.post('/install', authRequired, async (req, res) => {
  try {
    const { site_id, module_id, config, show_on_public } = req.body;
    if (!site_id || !module_id) return res.status(400).json({ error: 'site_id and module_id required' });

    // Get current max sort_order for this site
    const { data: existing } = await supabase
      .from('user_modules')
      .select('sort_order')
      .eq('site_id', site_id)
      .order('sort_order', { ascending: false })
      .limit(1);

    const nextOrder = existing?.length ? (existing[0].sort_order + 1) : 0;

    const { data, error } = await supabase
      .from('user_modules')
      .upsert({
        site_id,
        module_id,
        config: config || {},
        show_on_public: show_on_public !== false,
        is_active: true,
        sort_order: nextOrder,
      }, { onConflict: 'site_id,module_id' })
      .select('*, module_manifest(*)')
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: uninstall a module ──────────────────────────────────
router.delete('/uninstall/:module_id', authRequired, async (req, res) => {
  try {
    const { site_id } = req.query;
    const { module_id } = req.params;

    // Prevent uninstalling core modules
    const { data: manifest } = await supabase
      .from('module_manifest')
      .select('is_core')
      .eq('id', module_id)
      .single();

    if (manifest?.is_core) return res.status(400).json({ error: 'Core modules cannot be uninstalled' });

    const { error } = await supabase
      .from('user_modules')
      .update({ is_active: false })
      .eq('site_id', site_id)
      .eq('module_id', module_id);

    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: update module config ────────────────────────────────
router.patch('/config/:module_id', authRequired, async (req, res) => {
  try {
    const { site_id, config, show_on_public, sort_order } = req.body;
    const updates = {};
    if (config !== undefined) updates.config = config;
    if (show_on_public !== undefined) updates.show_on_public = show_on_public;
    if (sort_order !== undefined) updates.sort_order = sort_order;

    const { data, error } = await supabase
      .from('user_modules')
      .update(updates)
      .eq('site_id', site_id)
      .eq('module_id', req.params.module_id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: reorder installed modules ──────────────────────────
router.post('/reorder', authRequired, async (req, res) => {
  try {
    const { site_id, order } = req.body; // order = [{module_id, sort_order}]
    const updates = order.map(({ module_id, sort_order }) =>
      supabase.from('user_modules').update({ sort_order }).eq('site_id', site_id).eq('module_id', module_id)
    );
    await Promise.all(updates);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: get what modules should show for this site ──────────
// Used by module-loader.js as a drop-in replacement
router.get('/active-ids', authRequired, async (req, res) => {
  try {
    const { site_id } = req.query;

    // Get installed modules
    const { data: installed } = await supabase
      .from('user_modules')
      .select('module_id, sort_order')
      .eq('site_id', site_id)
      .eq('is_active', true)
      .order('sort_order');

    // Always include core modules
    const { data: core } = await supabase
      .from('module_manifest')
      .select('id')
      .eq('is_core', true);

    const coreIds = (core || []).map(m => m.id);
    const installedIds = (installed || []).map(m => m.module_id);

    // Merge: core first, then installed (deduped)
    const all = [...new Set([...coreIds, ...installedIds])];
    res.json({ modules: all });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
