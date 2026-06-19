// Cache buster: 2026-06-01T02
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: 'GCR API running', version: '2026-06-17', endpoints: 'api/gcr/*, api/admin/*, api/dashboard/*, api/public/*, api/auth/*, api/user/*, api/site/*, api/menu-editor/*, api/tourist/*, api/tourist-auth/*' }));

// Auth
app.use('/api/auth', require('./routes/auth'));

// GCR & Admin
app.use('/api/gcr', require('./routes/gcr'));
app.use('/api/admin', require('./routes/admin'));

// Dashboard (business owner)
app.use('/api/dashboard', require('./routes/dashboard'));

// Public
app.use('/api/public', require('./routes/public'));

// User
app.use('/api/user', require('./routes/user'));

// Site
app.use('/api/site', require('./routes/site'));

// Menu
app.use('/api/menu-editor', require('./routes/menu-editor'));
app.use('/api/menu-edit', require('./routes/menu-edit'));
app.use('/api/simple', require('./routes/simple-menu-edit'));

// Tourist
app.use('/api/tourist-auth', require('./routes/tourist-auth'));
app.use('/api/tourist', require('./routes/tourist'));
app.use('/api/tourist/groups', require('./routes/tourist-groups'));

// Admin tourists
app.use('/api/admin/tourists', require('./routes/admin-tourists'));

// Setup questions
app.use('/api/admin/setup-questions', require('./routes/setup-questions'));

// Apps & Modules
app.use('/api/apps', require('./routes/apps'));
app.use('/api/modules', require('./routes/modules'));

// Google Business
app.use('/api/google-business', require('./routes/google-business'));
app.use('/api/dashboard/google-business', require('./routes/google-business'));

// SMS
app.use('/api/sms', require('./routes/sms'));

// QR & Redirects
app.use('/api/qr', require('./routes/qr'));
app.use('/api/links', require('./routes/links'));

// Update links
app.use('/api/update', require('./routes/update-link'));
app.use('/update', require('./routes/update-link'));

// Payments — Stripe and Square
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/square', require('./routes/square'));
app.use('/api/webhooks', require('./routes/webhooks'));

// Booking types
app.use('/api/availability', require('./routes/availability'));
app.use('/api/boat-rental', require('./routes/boat-rental'));
app.use('/api/charter', require('./routes/charter'));
app.use('/api/rides', require('./routes/rides'));
app.use('/api/photographer', require('./routes/photographer'));
app.use('/api/integrations/fareharbor', require('./routes/fareharbor'));

// Live photo
app.use('/api/live-photo', require('./routes/live-photo'));

// AI Provider
app.use('/api/ai-provider', require('./routes/ai-provider'));

// Reviews & Analytics
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/analytics', require('./routes/analytics'));

// WhatsApp, Voice Notes, OCR, DNS
app.use('/api/whatsapp', require('./routes/whatsapp'));
app.use('/api/voice-notes', require('./routes/voice-notes'));
app.use('/api/ocr', require('./routes/ocr'));
app.use('/api/verify-dns', require('./routes/verify-dns'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`GCR API listening on port ${PORT}`));
