// ─────────────────────────────────────────────────────────────────────────
// GCR v2 iCal availability sync — ADDITIVE, does not touch any live route.
//
// Airbnb, VRBO, and most booking platforms give a host a private iCal (.ics)
// feed URL per listing. This pulls that feed for a resource (a condo unit, a
// boat), turns each reserved period into a real row in v2.availability_blocks,
// and keeps it in sync on repeat calls — safe to call on a schedule.
//
// Mounted at /api/gcr/v2-preview/ical
//   POST /resource/:resource_id/connect  { ical_url }   -- register/update the feed
//   POST /resource/:resource_id/sync                     -- pull + sync one resource
//   POST /sync-all                                       -- pull + sync every connected resource
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const ical = require('node-ical');

const dbv2 = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY,
  { db: { schema: 'v2' } }
);

function toDateString(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

// Pull one iCal feed and sync it into availability_blocks for one resource.
// Upserts events still present in the feed, removes ical-sourced blocks for
// events that dropped out of the feed (cancellations) -- never touches
// blocks with source != 'ical_sync' (manually entered blackouts stay put).
async function syncResourceFromIcal(resourceId, icalUrl) {
  const events = await ical.async.fromURL(icalUrl);
  const uids = [];
  const rows = [];

  for (const key in events) {
    const ev = events[key];
    if (ev.type !== 'VEVENT' || !ev.start || !ev.end || !ev.uid) continue;
    uids.push(ev.uid);
    rows.push({
      resource_id: resourceId,
      start_date: toDateString(ev.start),
      end_date: toDateString(ev.end),
      reason: ev.summary || 'Booked',
      source: 'ical_sync',
      external_uid: ev.uid,
      synced_at: new Date().toISOString(),
    });
  }

  if (rows.length > 0) {
    const { error: upsertErr } = await dbv2
      .from('availability_blocks')
      .upsert(rows, { onConflict: 'resource_id,external_uid' });
    if (upsertErr) throw upsertErr;
  }

  // Remove ical-sourced blocks whose event is no longer in the feed
  let deleteQuery = dbv2
    .from('availability_blocks')
    .delete()
    .eq('resource_id', resourceId)
    .eq('source', 'ical_sync');
  if (uids.length > 0) deleteQuery = deleteQuery.not('external_uid', 'in', `(${uids.map(u => `"${u}"`).join(',')})`);
  const { error: deleteErr } = await deleteQuery;
  if (deleteErr) throw deleteErr;

  return { events_found: rows.length };
}

router.post('/resource/:resource_id/connect', async (req, res) => {
  try {
    const { resource_id } = req.params;
    const { ical_url } = req.body;
    if (!ical_url) return res.status(400).json({ error: 'ical_url is required' });

    const { data: resource, error: resErr } = await dbv2
      .from('resources').select('id').eq('id', resource_id).maybeSingle();
    if (resErr) throw resErr;
    if (!resource) return res.status(404).json({ error: 'Resource not found in v2' });

    const { data, error } = await dbv2
      .from('resource_calendar_sources')
      .upsert({ resource_id, source_type: 'ical', url: ical_url }, { onConflict: 'resource_id,source_type' })
      .select()
      .maybeSingle();
    if (error) throw error;

    res.json({ connected: true, source: data });
  } catch (err) {
    console.error('[ical-sync] connect error:', err);
    res.status(500).json({ error: err.message || 'connect failed' });
  }
});

router.post('/resource/:resource_id/sync', async (req, res) => {
  try {
    const { resource_id } = req.params;
    const { data: source, error } = await dbv2
      .from('resource_calendar_sources')
      .select('url')
      .eq('resource_id', resource_id)
      .eq('source_type', 'ical')
      .maybeSingle();
    if (error) throw error;
    if (!source) return res.status(404).json({ error: 'No iCal source connected for this resource yet -- call /connect first' });

    const result = await syncResourceFromIcal(resource_id, source.url);
    res.json({ resource_id, ...result });
  } catch (err) {
    console.error('[ical-sync] sync error:', err);
    res.status(500).json({ error: err.message || 'sync failed' });
  }
});

router.post('/sync-all', async (req, res) => {
  try {
    const { data: sources, error } = await dbv2
      .from('resource_calendar_sources')
      .select('resource_id, url')
      .eq('source_type', 'ical');
    if (error) throw error;

    const results = [];
    for (const s of sources || []) {
      try {
        const r = await syncResourceFromIcal(s.resource_id, s.url);
        results.push({ resource_id: s.resource_id, ok: true, ...r });
      } catch (e) {
        results.push({ resource_id: s.resource_id, ok: false, error: e.message });
      }
    }
    res.json({ synced: results.length, results });
  } catch (err) {
    console.error('[ical-sync] sync-all error:', err);
    res.status(500).json({ error: err.message || 'sync-all failed' });
  }
});

module.exports = router;
