// Quick-toggle SMS commands for business staff — separate from the
// tourist-facing signup/QR flow in routes/sms.js. A staff member (owner,
// manager, or a toggle-only "staff" role added via business_staff) texts
// the same inbound number; if their phone is recognized here, the message
// is treated as a command instead of falling through to tourist handling.
const { createClient } = require('@supabase/supabase-js');
const { logEdit } = require('./edit-log');

const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

// Each command flips one boolean column on one existing row — deliberately
// toggle-only (no create/delete/reprice via text), so a "staff" role person
// can safely be given only this channel while owner/manager get the full
// PIN-based editor too. nameGroup picks which regex capture group holds the
// item name, since "CATCH OF DAY" has an extra optional group for "THE".
const TOGGLE_COMMANDS = [
  { match: /^SOLD OUT\s+(.+)$/i,            table: 'menu_items',      field: 'is_available',    value: false },
  { match: /^AVAILABLE\s+(.+)$/i,           table: 'menu_items',      field: 'is_available',    value: true },
  { match: /^BACK IN STOCK\s+(.+)$/i,       table: 'menu_items',      field: 'is_available',    value: true },
  { match: /^CATCH OF( THE)? DAY\s+(.+)$/i, table: 'menu_items',      field: 'is_catch_of_day', value: true, nameGroup: 2 },
  { match: /^ON TAP\s+(.+)$/i,              table: 'menu_items',      field: 'is_on_tap',       value: true },
  { match: /^OFF TAP\s+(.+)$/i,             table: 'menu_items',      field: 'is_on_tap',       value: false },
  { match: /^SPECIAL ON\s+(.+)$/i,          table: 'entity_specials', field: 'is_active',       value: true },
  { match: /^SPECIAL OFF\s+(.+)$/i,         table: 'entity_specials', field: 'is_active',       value: false },
];

async function findStaff(phone) {
  const { data } = await db.from('business_staff').select('*').eq('phone', phone).eq('is_active', true);
  return data || [];
}

async function findItemByName(entitySlug, table, name) {
  const nameCol = table === 'menu_items' ? 'item_name' : 'special_name';
  const { data } = await db.from(table).select('*').eq('entity_slug', entitySlug).ilike(nameCol, `%${name.trim()}%`);
  return data || [];
}

// Returns a reply string if this text was handled as a staff command, or
// null if the phone isn't a recognized staff number at all — callers should
// fall through to their normal (tourist) handling in that case.
async function handleStaffCommand(phone, body) {
  const staffRows = await findStaff(phone);
  if (!staffRows.length) return null;

  const trimmed = body.trim();
  const cmd = TOGGLE_COMMANDS.find(c => c.match.test(trimmed));
  if (!cmd) {
    return `Didn't recognize that. Try: SOLD OUT <item>, AVAILABLE <item>, CATCH OF DAY <item>, ON TAP <item>, OFF TAP <item>, SPECIAL ON/OFF <name>.`;
  }

  // A phone linked to more than one business can't be resolved from the text
  // alone — safer to say so than guess wrong.
  if (staffRows.length > 1) {
    return `You're linked to ${staffRows.length} businesses — texting a toggle isn't supported for that yet. Use your dashboard link instead.`;
  }
  const staff = staffRows[0];

  const m = trimmed.match(cmd.match);
  const name = m[cmd.nameGroup || 1];

  const matches = await findItemByName(staff.entity_slug, cmd.table, name);
  if (!matches.length) return `Couldn't find "${name}" — check the spelling and try again.`;
  if (matches.length > 1) return `Found ${matches.length} items matching "${name}" — be more specific.`;

  const item = matches[0];
  const { error } = await db.from(cmd.table).update({ [cmd.field]: cmd.value }).eq('id', item.id);
  if (error) return `Something went wrong updating that — try again in a moment.`;

  logEdit({
    entity_slug: staff.entity_slug, channel: 'sms', actor_phone: phone, actor_name: staff.name, actor_role: staff.role,
    action: 'toggle', table_name: cmd.table, record_id: item.id, field_name: cmd.field,
    old_value: item[cmd.field], new_value: cmd.value,
  });

  const itemLabel = item.item_name || item.special_name || name;
  return `Done — ${itemLabel} updated.`;
}

module.exports = { handleStaffCommand };
