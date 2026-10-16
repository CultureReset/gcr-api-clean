// DRAFT. Menus owner routes on the canonical ng.* tables. Business resolved from the session
// (middleware/ownerAuth.js → req.business). Every write emits an event.
const express = require('express');
const db = require('../../../db');
const { emit, changed } = require('../../../lib/events/emit');

const router = express.Router();
const ng = () => db.schema('ng');
const actorOf = (req) => ({ kind: req.agent ? 'agent' : 'user', id: (req.user && req.user.id) || null, paperclipTaskId: req.get('x-paperclip-task-id') || null });
const bizId = (req) => req.business && req.business.id; // TODO: wire to ownerAuth / install token

router.get('/', async (req, res) => {
  const { data, error } = await ng().from('menu')
    .select('id, kind, name, menu_section(id, name, sort_order, menu_item(id, name, description, price_cents, is_available, sort_order))')
    .eq('business_id', bizId(req)).order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ menus: data });
});

router.get('/summary', async (req, res) => {
  const { count } = await ng().from('menu_item').select('id', { count: 'exact', head: true }).eq('business_id', bizId(req));
  res.json({ items: count || 0 });
});

router.post('/items', async (req, res) => {
  const { section_id, name, description, price_cents, is_available = true } = req.body || {};
  if (!section_id || !name) return res.status(400).json({ error: 'section_id and name are required' });
  const { data, error } = await ng().from('menu_item')
    .insert({ business_id: bizId(req), section_id, name, description, price_cents, is_available }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await emit({ businessId: bizId(req), moduleId: 'menus', type: 'menus.item.created', entityTable: 'ng.menu_item', entityId: data.id, payload: { after: data }, actor: actorOf(req) });
  res.status(201).json(data);
});

router.patch('/items/:id', async (req, res) => {
  const allowed = ['name', 'description', 'price_cents', 'is_available', 'is_feature', 'sort_order', 'section_id', 'dietary'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const { data: before } = await ng().from('menu_item').select('*').eq('id', req.params.id).eq('business_id', bizId(req)).single();
  if (!before) return res.status(404).json({ error: 'not found' });
  const { data, error } = await ng().from('menu_item').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('business_id', bizId(req)).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await emit({ businessId: bizId(req), moduleId: 'menus', type: 'menus.item.updated', entityTable: 'ng.menu_item', entityId: data.id, payload: { before, after: data, changed: changed(before, data) }, actor: actorOf(req) });
  res.json(data);
});

router.delete('/items/:id', async (req, res) => {
  const { data: before } = await ng().from('menu_item').select('*').eq('id', req.params.id).eq('business_id', bizId(req)).single();
  if (!before) return res.status(404).json({ error: 'not found' });
  const { error } = await ng().from('menu_item').delete().eq('id', req.params.id).eq('business_id', bizId(req));
  if (error) return res.status(400).json({ error: error.message });
  await emit({ businessId: bizId(req), moduleId: 'menus', type: 'menus.item.deleted', entityTable: 'ng.menu_item', entityId: before.id, payload: { before }, actor: actorOf(req) });
  res.json({ ok: true });
});

module.exports = router;
