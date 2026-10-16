// DRAFT. gcr-api-clean side of the event link:
//   GET  /api/nextgent/events?businessId=&after=   Paperclip pulls missed events (signed)
//   POST /api/nextgent/events/tick                 runs one delivery pass (signed; cron can call it)
const express = require('express');
const db = require('../db');
const { requireSignature } = require('../lib/nextgent/sign');
const worker = require('../lib/events/worker');

const router = express.Router();
router.use(requireSignature());

router.get('/', async (req, res) => {
  let q = db.schema('ng').from('events_outbox').select('*').order('id').limit(Math.min(Number(req.query.limit) || 100, 500));
  if (req.query.businessId) q = q.eq('business_id', req.query.businessId);
  if (req.query.after) q = q.gt('id', Number(req.query.after));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data });
});

router.post('/tick', async (_req, res) => {
  try { res.json(await worker.tick()); } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
