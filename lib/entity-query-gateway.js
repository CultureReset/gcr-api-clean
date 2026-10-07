/**
 * Canonical public Entity query boundary.
 *
 * Web, MCP, search adapters and future custom-domain hosts should read the
 * same assembled Entity model through this module. Today it delegates to the
 * proven GCR buildFullEntity() implementation; later that assembler can move
 * here without changing its consumers.
 */
async function readPublicEntity(slug) {
  const gcrRouter = require('../routes/gcr')
  return gcrRouter.buildFullEntity(slug)
}

module.exports = { readPublicEntity }
