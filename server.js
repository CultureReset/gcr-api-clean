// Cache buster: 2026-06-01T02
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Fail-safe route mount: a broken/WIP route file is skipped with a warning
// instead of crashing the entire API on boot.
function mount(path, modPath) {
  try {
    app.use(path, require(modPath));
  } catch (e) {
    console.error(`[mount skipped] ${path} -> ${modPath}: ${e.message}`);
  }
}

app.get('/', (req, res) => res.json({ status: 'GCR API running', version: '2026-06-17', endpoints: 'api/gcr/*, api/admin/*, api/dashboard/*, api/public/*, api/auth/*, api/user/*, api/site/*, api/menu-editor/*, api/tourist/*, api/tourist-auth/*' }));

// Auth
mount('/api/auth', './routes/auth');

// GCR & Admin
mount('/api/gcr', './routes/gcr');
mount('/api/admin', './routes/admin');

// Dashboard (business owner)
mount('/api/dashboard', './routes/dashboard');

// Public
mount('/api/public', './routes/public');

// User
mount('/api/user', './routes/user');

// Site
mount('/api/site', './routes/site');

// Menu
mount('/api/menu-editor', './routes/menu-editor');
mount('/api/menu-edit', './routes/menu-edit');
mount('/api/simple', './routes/simple-menu-edit');

// Tourist
mount('/api/tourist-auth', './routes/tourist-auth');
mount('/api/tourist', './routes/tourist');
mount('/api/tourist/groups', './routes/tourist-groups');

// Admin tourists
mount('/api/admin/tourists', './routes/admin-tourists');

// Setup questions
mount('/api/admin/setup-questions', './routes/setup-questions');

// Apps & Modules
mount('/api/apps', './routes/apps');
mount('/api/modules', './routes/modules');

// Google Business
mount('/api/google-business', './routes/google-business');
mount('/api/dashboard/google-business', './routes/google-business');

// SMS
mount('/api/sms', './routes/sms');

// QR & Redirects
mount('/api/qr', './routes/qr');
mount('/api/links', './routes/links');

// Update links
mount('/api/update', './routes/update-link');
mount('/update', './routes/update-link');

// Payments — Stripe and Square
mount('/api/stripe', './routes/stripe');
mount('/api/square', './routes/square');
mount('/api/webhooks', './routes/webhooks');

// Booking types
mount('/api/availability', './routes/availability');
mount('/api/boat-rental', './routes/boat-rental');
mount('/api/charter', './routes/charter');
mount('/api/rides', './routes/rides');
mount('/api/photographer', './routes/photographer');
mount('/api/integrations/fareharbor', './routes/fareharbor');

// Live photo
mount('/api/live-photo', './routes/live-photo');

// AI Provider
mount('/api/ai-provider', './routes/ai-provider');

// Reviews & Analytics
mount('/api/reviews', './routes/reviews');
mount('/api/analytics', './routes/analytics');

// WhatsApp, Voice Notes, OCR, DNS
mount('/api/whatsapp', './routes/whatsapp');
mount('/api/voice-notes', './routes/voice-notes');
mount('/api/ocr', './routes/ocr');
mount('/api/verify-dns', './routes/verify-dns');

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`GCR API listening on port ${PORT}`));
