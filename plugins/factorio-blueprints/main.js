// extensions/otix-plugins/plugins/factorio-blueprints/main.js
// Factorio Blueprint vault and community sharing plugin for Otix

const zlib = require('zlib')
const crypto = require('crypto')

/**
 * Decode a Factorio blueprint string.
 * Format chain: base64 -> zlib inflate -> UTF-8 JSON
 *
 * @param {string} raw - The blueprint string (starts with '0' for blueprint, '1' for book)
 * @returns {ParsedBlueprint}
 */
function decodeBlueprint(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Invalid blueprint string: must be a non-empty string')
  }

  const versionByte = raw[0]
  if (versionByte !== '0' && versionByte !== '1') {
    throw new Error('Invalid blueprint string: must start with 0 or 1')
  }

  // Strip version byte and decode base64
  const encoded = raw.slice(1)
  let buffer
  try {
    buffer = Buffer.from(encoded, 'base64')
    if (buffer.length === 0) {
      throw new Error('Empty after base64 decode')
    }
  } catch {
    throw new Error('Invalid blueprint string: base64 decode failed')
  }

  // Zlib inflate
  let jsonStr
  try {
    jsonStr = zlib.inflateSync(buffer).toString('utf8')
  } catch {
    throw new Error('Invalid blueprint string: zlib decompression failed')
  }

  // Parse JSON
  let data
  try {
    data = JSON.parse(jsonStr)
  } catch {
    throw new Error('Invalid blueprint string: JSON parse failed')
  }

  const bp = data.blueprint || data.blueprint_book
  if (!bp) {
    throw new Error('Invalid blueprint string: missing blueprint or blueprint_book key')
  }

  const entities = bp.entities || []
  const tiles = bp.tiles || []

  // Group entities by type and count
  const entityCounts = {}
  for (const entity of entities) {
    entityCounts[entity.name] = (entityCounts[entity.name] || 0) + 1
  }

  // Group tiles by type and count
  const tileCounts = {}
  for (const tile of tiles) {
    tileCounts[tile.name] = (tileCounts[tile.name] || 0) + 1
  }

  // Calculate dimensions
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const entity of entities) {
    const x = entity.position?.x
    const y = entity.position?.y
    if (x != null) { minX = Math.min(minX, x); maxX = Math.max(maxX, x) }
    if (y != null) { minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
  }
  for (const tile of tiles) {
    const x = tile.position?.x
    const y = tile.position?.y
    if (x != null) { minX = Math.min(minX, x); maxX = Math.max(maxX, x) }
    if (y != null) { minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
  }
  const dimensions = (minX === Infinity)
    ? { width: 0, height: 0 }
    : { width: maxX - minX + 1, height: maxY - minY + 1 }

  // Extract icons
  const icons = (bp.icons || []).map(icon => icon.signal?.name).filter(Boolean)

  return {
    type: data.blueprint_book ? 'blueprint-book' : 'blueprint',
    label: bp.label || 'Unnamed Blueprint',
    description: bp.description || '',
    icons,
    entities: entityCounts,
    entityCount: entities.length,
    tiles: tileCounts,
    tileCount: tiles.length,
    dimensions,
    version: bp.version ? String(bp.version) : 'unknown',
    raw,
    // For blueprint books, extract child info (children are already parsed JSON, not encoded strings)
    children: data.blueprint_book
      ? (bp.blueprints || []).map(child => ({
          type: 'blueprint',
          label: child.label || child.blueprint?.label || 'Unnamed Blueprint',
          icons: (child.blueprint?.icons || []).map((icon) => icon.signal?.name).filter(Boolean),
          entityCount: (child.blueprint?.entities || []).length,
        }))
      : undefined,
  }
}

module.exports = {
  plugin: function(ctx) {
    ctx.logger.info('Factorio Blueprints loaded')

    // Create SQLite schema on init
    ctx.db.run(`
      CREATE TABLE IF NOT EXISTS blueprints (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        description TEXT DEFAULT '',
        raw_string  TEXT NOT NULL,
        parsed_data TEXT NOT NULL,
        tags        TEXT DEFAULT '[]',
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      )
    `)
    ctx.db.run('CREATE INDEX IF NOT EXISTS idx_blueprints_label ON blueprints(label)')
    ctx.db.run('CREATE INDEX IF NOT EXISTS idx_blueprints_created ON blueprints(created_at)')

    ctx.handle('importBlueprint', async (args) => {
      const { rawString, label, description, tags } = args
      if (!rawString) {
        return { success: false, error: 'rawString required' }
      }
      if (rawString.length > 1_000_000) {
        return { success: false, error: 'Blueprint string too large (max 1MB)' }
      }
      try {
        const parsed = decodeBlueprint(rawString)

        // Check for duplicate (compare hash of raw string)
        const existing = ctx.db.get(
          'SELECT id FROM blueprints WHERE raw_string = ?',
          [rawString]
        )
        if (existing) {
          return { success: false, error: 'duplicate', blueprintId: existing.id }
        }

        const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)
        const tagsJson = JSON.stringify(tags || [])
        const parsedJson = JSON.stringify(parsed)

        ctx.db.run(
          `INSERT INTO blueprints (id, label, description, raw_string, parsed_data, tags) VALUES (?, ?, ?, ?, ?, ?)`,
          [id, label || parsed.label, description || parsed.description, rawString, parsedJson, tagsJson]
        )

        return { success: true, blueprint: { ...parsed, id, tags: tags || [] } }
      } catch (err) {
        return { success: false, error: err.message }
      }
    })

    ctx.handle('getBlueprints', async (args) => {
      const { search, sort_by, page = 1, page_size = 50 } = args || {}

      let where = ''
      let params = []
      if (search) {
        where = 'WHERE label LIKE ? OR description LIKE ?'
        params = [`%${search}%`, `%${search}%`]
      }

      let orderBy = 'created_at DESC'
      if (sort_by === 'name') orderBy = 'label ASC'
      if (sort_by === 'entity_count') orderBy = "json_extract(parsed_data, '$.entityCount') DESC"

      const offset = (page - 1) * page_size

      const rows = ctx.db.all(
        `SELECT id, label, description, parsed_data, tags, created_at FROM blueprints ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [...params, page_size, offset]
      )

      const total = ctx.db.get(
        `SELECT COUNT(*) as count FROM blueprints ${where}`, params
      )

      return {
        success: true,
        blueprints: rows.map(r => ({
          ...r,
          parsed_data: JSON.parse(r.parsed_data),
          tags: JSON.parse(r.tags),
        })),
        total: total?.count || 0,
        page,
        page_size,
      }
    })

    ctx.handle('deleteBlueprint', async (args) => {
      const { id } = args
      if (!id) return { success: false, error: 'id required' }

      ctx.db.run('DELETE FROM blueprints WHERE id = ?', [id])
      return { success: true }
    })

    ctx.handle('updateBlueprint', async (args) => {
      const { id, label, description, tags } = args
      if (!id) return { success: false, error: 'id required' }

      const sets = []
      const params = []
      if (label !== undefined) { sets.push('label = ?'); params.push(label) }
      if (description !== undefined) { sets.push('description = ?'); params.push(description) }
      if (tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(tags)) }

      if (sets.length === 0) return { success: false, error: 'no fields to update' }

      sets.push("updated_at = datetime('now')")
      params.push(id)

      ctx.db.run(`UPDATE blueprints SET ${sets.join(', ')} WHERE id = ?`, params)
      return { success: true }
    })

    ctx.handle('exportBlueprint', async (args) => {
      const { id } = args
      if (!id) return { success: false, error: 'id required' }

      const row = ctx.db.get('SELECT raw_string FROM blueprints WHERE id = ?', [id])
      if (!row) return { success: false, error: 'not found' }

      return { success: true, rawString: row.raw_string }
    })

    // ── Community handlers ──

    function communityGuard() {
      if (!ctx.config?.get('community_enabled')) {
        return { success: false, error: 'Community sharing disabled' }
      }
      return null
    }

    ctx.handle('community.list', async (args) => {
      const guard = communityGuard()
      if (guard) return guard

      const sortMap = { recent: 'created_at', popular: 'downloads', trending: 'downloads' }
      const { q, sort = 'recent', page = 1, page_size = 24 } = args || {}
      try {
        const mappedSort = sortMap[sort] || 'created_at'
        const offset = (page - 1) * page_size
        const params = new URLSearchParams({ sort: mappedSort, offset: String(offset), limit: String(page_size) })
        if (q) params.set('q', q)
        const res = await ctx.api.get(`/api/blueprints/?${params.toString()}`)
        const normalized = Array.isArray(res) ? { results: res, count: res.length } : res
        return { success: true, ...normalized }
      } catch (err) {
        ctx.logger.error('community.list failed:', err)
        return { success: false, error: 'Community unavailable' }
      }
    })

    ctx.handle('community.upload', async (args) => {
      const guard = communityGuard()
      if (guard) return guard

      const { blueprintId, title, description, tags } = args
      if (!blueprintId) return { success: false, error: 'blueprintId required' }

      const row = ctx.db.get('SELECT raw_string, parsed_data FROM blueprints WHERE id = ?', [blueprintId])
      if (!row) return { success: false, error: 'Blueprint not found in vault' }

      try {
        const parsed = JSON.parse(row.parsed_data)
        const res = await ctx.api.post('/api/blueprints/', {
          title: title || parsed.label,
          description: description || parsed.description,
          blueprint_string: row.raw_string,
          parsed_data: parsed,
          tags: tags || [],
        })
        return { success: true, communityBlueprint: res }
      } catch (err) {
        ctx.logger.error('community.upload failed:', err)
        return { success: false, error: 'Upload failed' }
      }
    })

    ctx.handle('community.detail', async (args) => {
      const guard = communityGuard()
      if (guard) return guard

      const { id } = args
      if (!id) return { success: false, error: 'id required' }
      try {
        const res = await ctx.api.get(`/api/blueprints/${id}/`)
        return { success: true, blueprint: res }
      } catch (err) {
        return { success: false, error: 'Failed to load community blueprint' }
      }
    })

    ctx.handle('community.like', async (args) => {
      const guard = communityGuard()
      if (guard) return guard

      const { id } = args
      if (!id) return { success: false, error: 'id required' }
      try {
        const res = await ctx.api.post(`/api/blueprints/${id}/like/`)
        return { success: true, liked: res.is_liked, like_count: res.like_count }
      } catch {
        return { success: false, error: 'Failed to toggle like' }
      }
    })

    ctx.onDestroy(() => {
      ctx.logger.info('Factorio Blueprints unloaded')
    })
  },

  slotRender: async function(ctx, location) {
    return {
      widgets: [{
        type: 'game-tab',
        props: {
          tabId: 'blueprints',
          label: 'Blueprints',
          gameIds: ['427520'],
        }
      }]
    }
  },

  status: async function(ctx) {
    return { loaded: true }
  },

  test: async function(ctx, configDraft) {
    return { passed: true }
  }
}
