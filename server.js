// Cache buster: 2026-06-01
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: 'GCR API running', endpoints: 'api/gcr/*, api/admin/*, api/menu-editor/*, api/tourist/*, api/tourist-auth/*' }));
app.use('/api/gcr', require('./routes/gcr'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/menu-editor', require('./routes/menu-editor'));
app.use('/api/tourist-auth', require('./routes/tourist-auth'));
app.use('/api/tourist', require('./routes/tourist'));
app.use('/api/tourist/groups', require('./routes/tourist-groups'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`GCR API listening on port ${PORT}`));
