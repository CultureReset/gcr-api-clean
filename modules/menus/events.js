// DRAFT. Menus consumes media.photo.deleted to clear item photos.
const db = require('../../db');
exports.handle = async (evt) => {
  if (evt.type === 'media.photo.deleted' && evt.entity_id) {
    await db.schema('ng').from('menu_item').update({ media_id: null }).eq('media_id', evt.entity_id);
  }
};
