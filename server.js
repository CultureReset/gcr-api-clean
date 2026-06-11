// Cache buster: 2026-06-01T02
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: 'GCR API running', version: '2026-06-01T02', endpoints: 'api/gcr/*, api/admin/*, api/menu-editor/*, api/tourist/*, api/tourist-auth/*' }));
app.use('/api/gcr', require('./routes/gcr'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/menu-editor', require('./routes/menu-editor'));
app.use('/api/tourist-auth', require('./routes/tourist-auth'));
app.use('/api/tourist', require('./routes/tourist'));
app.use('/api/tourist/groups', require('./routes/tourist-groups'));
app.use('/api/sms', require('./routes/sms'));

// QR & Redirects
app.use('/api/qr', require('./routes/qr'));
app.use('/api/links', require('./routes/links'));

// Payments — Stripe and Square are separate, independent routes
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/square', require('./routes/square'));
app.use('/api/webhooks', require('./routes/webhooks'));

// Booking types
app.use('/api/availability', require('./routes/availability'));
app.use('/api/boat-rental', require('./routes/boat-rental'));
app.use('/api/charter', require('./routes/charter'));
app.use('/api/rides', require('./routes/rides'));
app.use('/api/photographer', require('./routes/photographer'));

// Reviews & Analytics
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/analytics', require('./routes/analytics'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`GCR API listening on port ${PORT}`));
