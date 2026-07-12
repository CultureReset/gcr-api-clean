const { createClient } = require('@supabase/supabase-js');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

// Records one row per write to entity_edit_log — who (phone/name/role),
// what channel (menu_editor/dashboard/sms/admin), what changed. Never throws:
// a logging failure must not take down the actual write it's describing.
async function logEdit({ entity_slug, channel, actor_phone = null, actor_name = null, actor_role = null, action, table_name, record_id = null, field_name = null, old_value = null, new_value = null }) {
  try {
    await db.from('entity_edit_log').insert({
      entity_slug, channel, actor_phone, actor_name, actor_role,
      action, table_name, record_id: record_id != null ? String(record_id) : null,
      field_name, old_value, new_value,
    });
  } catch (err) {
    console.warn('[edit-log] failed to record edit:', err.message);
  }
}

module.exports = { logEdit };
