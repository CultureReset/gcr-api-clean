// DRAFT. Loads modules/<id>/manifest.json, validates it, mounts its routers, exposes event handlers.
// Opt-in: server.js calls mountModules(app, mount) only when NEXTGENT_MODULES=1.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'modules');
const registry = new Map(); // id → { manifest, dir }

function validate(m, schema) {
  // Minimal structural check without a dependency; swap for ajv in phase 1 proper.
  const errs = [];
  for (const k of schema.required) if (!(k in m)) errs.push(`missing ${k}`);
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(m.id || '')) errs.push('bad id');
  for (const t of m.tables || []) if (!/^ng\.[a-z_]+$/.test(t.name)) errs.push(`table ${t.name} must be in schema ng`);
  for (const e of (m.events && m.events.emits) || []) if (!e.startsWith(`${m.id}.`)) errs.push(`emits ${e} must start with ${m.id}.`);
  return errs;
}

function load() {
  if (registry.size) return registry;
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, '_schema', 'manifest.schema.json'), 'utf8'));
  for (const id of fs.readdirSync(ROOT)) {
    if (id.startsWith('_')) continue;
    const file = path.join(ROOT, id, 'manifest.json');
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errs = validate(manifest, schema);
    if (errs.length) { console.error(`[modules] ${id} rejected: ${errs.join('; ')}`); continue; }
    if (manifest.id !== id) { console.error(`[modules] ${id}: folder name must equal manifest id`); continue; }
    registry.set(id, { manifest, dir: path.join(ROOT, id) });
  }
  return registry;
}

/** Mount each module's routers at the standard prefixes using server.js's mount(). */
function mountModules(app, mount) {
  for (const [id, { dir }] of load()) {
    const r = (f) => path.join(dir, 'routes', f);
    if (fs.existsSync(r('admin.js')))  mount(`/api/admin/m/${id}`, () => require(r('admin.js')));
    if (fs.existsSync(r('owner.js')))  mount(`/api/m/${id}`,       () => require(r('owner.js')));
    if (fs.existsSync(r('public.js'))) mount(`/api/p/${id}`,       () => require(r('public.js')));
  }
  app.get('/api/modules/manifests', (_req, res) =>
    res.json({ modules: [...load().values()].map((x) => x.manifest) }));
}

const manifest = (id) => (load().get(id) || {}).manifest || null;
function eventHandler(id) {
  const entry = load().get(id);
  if (!entry) return null;
  const f = path.join(entry.dir, 'events.js');
  return fs.existsSync(f) ? require(f).handle : null;
}

module.exports = { load, mountModules, manifest, eventHandler };
