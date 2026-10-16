// DRAFT. Public menu for website, QR, link page, listing. Read-only, cache-friendly.
const express = require('express');
const db = require('../../../db');
const router = express.Router();

router.get('/:slug', async (req, res) => {
  const ng = db.schema('ng');
  const { data: biz } = await ng.from('business').select('id, name, slug').eq('slug', req.params.slug).single();
  if (!biz) return res.status(404).json({ error: 'not found' });
  const { data } = await ng.from('menu')
    .select('kind, name, menu_section(name, sort_order, menu_item(name, description, price_cents, dietary, is_available, sort_order))')
    .eq('business_id', biz.id).eq('published', true).order('sort_order');
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.json({ business: biz, menus: data || [] });
});
module.exports = router;
