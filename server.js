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

// Dashboard (business owner)
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

// Tourist
mount('/api/tourist-auth', () => require('./routes/tourist-auth'));
mount('/api/tourist', () => require('./routes/tourist'));
mount('/api/tourist/groups', () => require('./routes/tourist-groups'));

// Admin tourists
mount('/api/admin/tourists', () => require('./routes/admin-tourists'));

// Setup questions
mount('/api/admin/setup-questions', () => require('./routes/setup-questions'));

// Apps & Modules
mount('/api/apps', () => require('./routes/apps'));
mount('/api/modules', () => require('./routes/modules'));

// Google Business
mount('/api/google-business', () => require('./routes/google-business'));
mount('/api/dashboard/google-business', () => require('./routes/google-business'));

// SMS
mount('/api/sms', () => require('./routes/sms'));

// QR & Redirects
mount('/api/qr', () => require('./routes/qr'));
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
mount('/api/boat-rental', () => require('./routes/boat-rental'));
mount('/api/charter', () => require('./routes/charter'));
mount('/api/rides', () => require('./routes/rides'));
mount('/api/photographer', () => require('./routes/photographer'));
mount('/api/integrations/fareharbor', () => require('./routes/fareharbor'));

// Live photo
mount('/api/live-photo', () => require('./routes/live-photo'));

// AI Provider
mount('/api/ai-provider', () => require('./routes/ai-provider'));

// Reviews & Analytics
mount('/api/reviews', () => require('./routes/reviews'));
mount('/api/analytics', () => require('./routes/analytics'));

// Artists & Live Music
mount('/api/artists', () => require('./routes/artists'));
mount('/api/webhooks', () => require('./routes/email-webhook'));

// WhatsApp, Voice Notes, OCR, DNS
mount('/api/whatsapp', () => require('./routes/whatsapp'));
mount('/api/voice-notes', () => require('./routes/voice-notes'));
mount('/api/ocr', () => require('./routes/ocr'));
mount('/api/verify-dns', () => require('./routes/verify-dns'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`GCR API listening on port ${PORT}`));
