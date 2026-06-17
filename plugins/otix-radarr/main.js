module.exports = function(ctx) {
  ctx.logger.info('Radarr Sync plugin starting', { version: '1.0.0' });

  // ── Config ──
  const radarrUrl = ctx.config.get('radarr_url') || 'http://localhost:7878';
  const apiKey = ctx.config.get('radarr_api_key') || '';
  const qualityProfileId = ctx.config.get('quality_profile_id') || 1;
  const rootFolderPath = ctx.config.get('root_folder_path') || '/movies';
  const pollMinutes = ctx.config.get('poll_interval_minutes') || 15;

  ctx.logger.info('Radarr config loaded', {
    url: radarrUrl,
    pollMinutes: pollMinutes
  });

  // ── Auto-managed list ──
  var managedListId = null;

  async function ensureList() {
    try {
      // Try to create a dedicated list
      var createRes = await ctx.api.post('/list', {
        name: 'Radarr Watchlist',
        description: 'Auto-managed list for Radarr sync. Movies added here are sent to Radarr.',
        isPublic: false
      });
      managedListId = createRes.id || createRes.list_id;
      ctx.logger.info('Created Radarr sync list', { listId: managedListId });
    } catch (err) {
      ctx.logger.warn('Could not create list, trying to find existing', { error: err.message });
      // Fallback: try to find an existing list
      try {
        var lists = await ctx.api.get('/list/mine');
        var radarrList = (Array.isArray(lists) ? lists : (lists.items || [])).find(function(l) {
          return l.name === 'Radarr Watchlist';
        });
        if (radarrList) {
          managedListId = radarrList.id;
          ctx.logger.info('Found existing Radarr sync list', { listId: managedListId });
        }
      } catch (err2) {
        ctx.logger.error('Failed to find or create list', { error: err2.message });
      }
    }
  }

  // ── Local DB: track synced items ──
  try {
    ctx.db.run(`
      CREATE TABLE IF NOT EXISTS radarr_sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_item_id TEXT NOT NULL,
        tmdb_id INTEGER,
        title TEXT,
        direction TEXT NOT NULL,
        radarr_id INTEGER,
        synced_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch (err) {
    ctx.logger.error('Failed to create sync log table', { error: err.message });
  }

  // ── Helper: Radarr API call ──
  function radarrApi(method, path, body) {
    var url = radarrUrl.replace(/\/+$/, '') + '/api/v3' + path;
    var headers = {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json'
    };
    var options = { method: method, headers: headers };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    return ctx.fetch(url, options);
  }

  // ── Helper: Check if already synced ──
  function isAlreadySynced(mediaItemId) {
    try {
      var row = ctx.db.get(
        'SELECT id FROM radarr_sync_log WHERE media_item_id = ?',
        [mediaItemId]
      );
      return !!row;
    } catch (err) {
      return false;
    }
  }

  // ── Helper: Record sync ──
  function recordSync(mediaItemId, tmdbId, title, direction, radarrId) {
    try {
      ctx.db.run(
        'INSERT INTO radarr_sync_log (media_item_id, tmdb_id, title, direction, radarr_id) VALUES (?, ?, ?, ?, ?)',
        [mediaItemId, tmdbId || null, title || '', direction, radarrId || null]
      );
    } catch (err) {
      ctx.logger.error('Failed to record sync', { error: err.message });
    }
  }

  // ── Core: Add movie to Radarr ──
  async function addToRadarr(tmdbId, title, mediaItemId) {
    if (!tmdbId) {
      ctx.logger.warn('No TMDb ID for media, cannot add to Radarr', { title: title, mediaItemId: mediaItemId });
      return false;
    }

    try {
      // Check if already in Radarr
      var lookupRes = await radarrApi('GET', '/movie/lookup/tmdb?tmdbId=' + tmdbId);
      if (!lookupRes.ok) {
        ctx.logger.warn('TMDb lookup failed', { tmdbId: tmdbId, status: lookupRes.status });
        return false;
      }
      var lookupData = await lookupRes.json();
      if (lookupData && lookupData.id) {
        ctx.logger.info('Movie already in Radarr', { title: title, radarrId: lookupData.id });
        recordSync(mediaItemId, tmdbId, title, 'otix_to_radarr', lookupData.id);
        return true;
      }
    } catch (err) {
      ctx.logger.warn('Lookup check failed, proceeding with add', { error: err.message });
    }

    try {
      var addRes = await radarrApi('POST', '/movie', {
        tmdbId: tmdbId,
        qualityProfileId: qualityProfileId,
        rootFolderPath: rootFolderPath,
        monitored: true,
        addOptions: { searchForMovie: true }
      });

      if (addRes.ok) {
        var movie = await addRes.json();
        ctx.logger.info('Added to Radarr', { title: title, radarrId: movie.id, tmdbId: tmdbId });
        ctx.notifications.send('Radarr Sync', 'Added: ' + title);
        recordSync(mediaItemId, tmdbId, title, 'otix_to_radarr', movie.id);
        return true;
      } else {
        var errText = await addRes.text();
        ctx.logger.error('Radarr add failed', { status: addRes.status, error: errText });
        return false;
      }
    } catch (err) {
      ctx.logger.error('Failed to add to Radarr', { title: title, error: err.message });
      return false;
    }
  }

  // ── Core: Look up Otix media to get TMDb ID ──
  async function lookupMedia(mediaItemId) {
    try {
      var media = await ctx.api.get('/media/' + mediaItemId);
      ctx.logger.info('Media lookup result keys', { keys: Object.keys(media || {}) });

      // Try various TMDb ID field names
      var tmdbId = media.tmdb_id || media.tmdbId || media.tmdbId || null;
      var title = media.title || media.name || 'Unknown';

      // If media has external_ids, check there too
      if (!tmdbId && media.external_ids) {
        tmdbId = media.external_ids.tmdb_id || media.external_ids.tmdbId || null;
      }
      if (!tmdbId && media.externalIds) {
        tmdbId = media.externalIds.tmdb_id || media.externalIds.tmdbId || null;
      }

      return { tmdbId: tmdbId, title: title, mediaType: media.mediaType || media.media_type };
    } catch (err) {
      ctx.logger.error('Failed to look up media', { mediaItemId: mediaItemId, error: err.message });
      return null;
    }
  }

  // ── Subscribe to events once list is ready ──
  var unsubListAdd = null;
  var pollInterval = null;

  ensureList().then(function() {
    ctx.logger.info('Radarr sync list ready', { managedListId: managedListId });
    if (!managedListId) {
      ctx.logger.error('No managed list available — sync will not work');
      return;
    }

    // ── 1. Listen for list item additions ──
    unsubListAdd = ctx.events.on('otix:list:item_added', function(payload) {
      if (payload.listId !== managedListId) return;

      var mediaItemId = payload.item && payload.item.mediaItemId;
      if (!mediaItemId) return;

      if (isAlreadySynced(mediaItemId)) {
        ctx.logger.info('Item already synced, skipping', { mediaItemId: mediaItemId });
        return;
      }

      ctx.logger.info('List item added — syncing to Radarr', { mediaItemId: mediaItemId });

      lookupMedia(mediaItemId).then(function(info) {
        if (!info) return;
        if (!info.tmdbId) {
          ctx.logger.warn('Media has no TMDb ID', { title: info.title, type: info.mediaType });
          return;
        }
        addToRadarr(info.tmdbId, info.title, mediaItemId);
      });
    });

    // ── 2. Periodic Radarr → Otix sync (if bidirectional) ──
    if (ctx.config.get('sync_direction') === 'bidirectional') {
      async function pollRadarr() {
        try {
          var res = await radarrApi('GET', '/movie');
          if (!res.ok) return;
          var movies = await res.json();

          for (var i = 0; i < movies.length; i++) {
            var movie = movies[i];
            if (!movie.tmdbId) continue;

            if (isAlreadySynced('tmdb-' + movie.tmdbId)) continue;

            // Add to Otix list — we record by tmdbId to avoid duplicates
            try {
              await ctx.api.post('/list/' + managedListId + '/item', {
                mediaItemId: 'tmdb-' + movie.tmdbId  // placeholder — need real Otix ID
              });
              recordSync('tmdb-' + movie.tmdbId, movie.tmdbId, movie.title, 'radarr_to_otix', movie.id);
            } catch (err) {
              ctx.logger.warn('Reverse sync — could not add to list', {
                title: movie.title,
                error: err.message
              });
            }
          }
        } catch (err) {
          ctx.logger.warn('Radarr poll failed', { error: err.message });
        }
      }

      pollInterval = setInterval(pollRadarr, pollMinutes * 60 * 1000);
      // Also run once on startup
      setTimeout(pollRadarr, 10000);
    }
  }).catch(function(err) {
    ctx.logger.error('Failed to initialize sync list', { error: err.message });
  });

  // ── Cleanup ──
  ctx.onDestroy(function() {
    ctx.logger.info('Radarr Sync plugin shutting down');
    if (unsubListAdd) unsubListAdd();
    if (pollInterval) clearInterval(pollInterval);

    try {
      var count = ctx.db.get('SELECT COUNT(*) as cnt FROM radarr_sync_log');
      ctx.logger.info('Total syncs', { total: count ? count.cnt : 0 });
    } catch (err) {}
  });

  ctx.logger.info('Radarr Sync plugin ready');
};

module.exports.test = async function(ctx, config) {
  const radarrUrl = (config.radarr_url || 'http://localhost:7878').replace(/\/+$/, '');
  const apiKey = config.radarr_api_key || '';

  if (!apiKey) {
    return { success: false, message: 'API Key is required.' };
  }

  try {
    const res = await ctx.fetch(radarrUrl + '/api/v3/system/status', {
      headers: { 'X-Api-Key': apiKey }
    });

    if (res.ok) {
      const data = await res.json();

      // Also fetch quality profiles and root folders for a richer response
      var extras = '';
      try {
        var profilesRes = await ctx.fetch(radarrUrl + '/api/v3/qualityprofile', {
          headers: { 'X-Api-Key': apiKey }
        });
        if (profilesRes.ok) {
          var profiles = await profilesRes.json();
          extras += 'Found ' + profiles.length + ' quality profiles';
        }
        var foldersRes = await ctx.fetch(radarrUrl + '/api/v3/rootfolder', {
          headers: { 'X-Api-Key': apiKey }
        });
        if (foldersRes.ok) {
          var folders = await foldersRes.json();
          extras += (extras ? ' and ' : 'Found ') + folders.length + ' root folders.';
        }
      } catch (fetchErr) {
        ctx.logger.warn('Failed to fetch extra Radarr data', { error: fetchErr.message });
      }

      return {
        success: true,
        message: 'Connected to Radarr v' + (data.version || '?') + '. ' + extras
      };
    }

    if (res.status === 401) {
      return { success: false, message: 'Authentication failed — check your API Key.' };
    }

    return { success: false, message: 'Connection failed (HTTP ' + res.status + ').' };
  } catch (err) {
    return { success: false, message: 'Could not reach Radarr at ' + radarrUrl + '. Is it running?' };
  }
};
