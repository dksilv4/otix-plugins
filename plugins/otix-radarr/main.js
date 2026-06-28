var main = function(ctx) {
  var STORAGE_KEY = 'instances';

  function getInstances() {
    return ctx.config.get(STORAGE_KEY) || [];
  }

  function saveInstances(instances) {
    ctx.config.set(STORAGE_KEY, instances);
  }

  ctx.handle('get-instances', function() {
    return getInstances().filter(function(i) { return i.enabled; });
  });

  ctx.handle('get-instance', function(args) {
    var instances = getInstances();
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].id === args.id) return instances[i];
    }
    return null;
  });

  ctx.handle('add-instance', function(args) {
    var instances = getInstances();
    instances.push(args);
    saveInstances(instances);
    return { success: true };
  });

  ctx.handle('update-instance', function(args) {
    var instances = getInstances();
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].id === args.id) {
        for (var key in args.config) {
          if (args.config.hasOwnProperty(key)) instances[i][key] = args.config[key];
        }
        saveInstances(instances);
        return { success: true };
      }
    }
    return { success: false, error: 'Instance not found' };
  });

  ctx.handle('remove-instance', function(args) {
    var instances = getInstances();
    saveInstances(instances.filter(function(i) { return i.id !== args.id; }));
    return { success: true };
  });

  ctx.handle('test-instance', async function(args) {
    var instances = getInstances();
    var instance = null;
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].id === args.id) { instance = instances[i]; break; }
    }
    if (!instance) return { ok: false, message: 'Instance not found' };
    try {
      var base = (instance.useSsl ? 'https' : 'http') + '://' + instance.host + ':' + instance.port + (instance.baseUrl || '');
      var response = await ctx.fetch(base + '/api/v3/system/status', {
        headers: { 'X-Api-Key': instance.apiKey },
      });
      if (!response.ok) return { ok: false, message: 'HTTP ' + response.status };
      var data = await response.json();
      return { ok: true, message: 'Radarr v' + (data.version || '?') };
    } catch(e) {
      return { ok: false, message: e.message };
    }
  });

  ctx.handle('getAllLibraries', async function() {
    var instances = getInstances();
    var results = [];
    for (var i = 0; i < instances.length; i++) {
      var instance = instances[i];
      if (!instance.enabled) continue;
      var base = (instance.useSsl ? 'https' : 'http') + '://' + instance.host + ':' + instance.port + (instance.baseUrl || '');
      try {
        var response = await ctx.fetch(base + '/api/v3/movie', {
          headers: { 'X-Api-Key': instance.apiKey }
        });
        if (!response.ok) {
          results.push({
            name: instance.name,
            url: base,
            count: 0,
            movies: [],
            error: 'HTTP ' + response.status
          });
          continue;
        }
        var movies = await response.json();
        results.push({
          name: instance.name,
          url: base,
          count: movies.length,
          movies: movies.map(function(m) {
            return {
              id: m.id,
              title: m.title,
              year: m.year,
              images: m.images ? m.images.map(function(img) {
                return {
                  coverType: img.coverType,
                  remoteUrl: img.remoteUrl || (base + img.url + '?apikey=' + instance.apiKey)
                };
              }) : []
            };
          })
        });
      } catch (e) {
        results.push({
          name: instance.name,
          url: base,
          count: 0,
          movies: [],
          error: e.message || String(e)
        });
      }
    }
    return results;
  });

  // Watchlist manual request handler
  ctx.handle('request-movie', async function(args) {
    var instanceId = args.instanceId;
    var tmdbId = args.tmdbId;

    var instances = getInstances();
    var instance = null;
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].id === instanceId) { instance = instances[i]; break; }
    }
    if (!instance) return { success: false, error: 'Instance not found' };

    var base = (instance.useSsl ? 'https' : 'http') + '://' + instance.host + ':' + instance.port + (instance.baseUrl || '');
    try {
      // 1. Search Radarr using tmdbId lookup
      var lookupUrl = base + '/api/v3/movie/lookup/tmdb?tmdbId=' + tmdbId;
      var lookupRes = await ctx.fetch(lookupUrl, {
        headers: { 'X-Api-Key': instance.apiKey }
      });
      if (!lookupRes.ok) return { success: false, error: 'Radarr lookup failed: HTTP ' + lookupRes.status };
      var movieDetails = await lookupRes.json();
      if (!movieDetails) return { success: false, error: 'No movie details found' };

      if (movieDetails.id) return { passed: true };

      // 2. Resolve qualityProfileId
      var qualityProfileId = parseInt(instance.qualityProfile, 10);
      if (isNaN(qualityProfileId)) {
        var profileUrl = base + '/api/v3/qualityprofile';
        var profileRes = await ctx.fetch(profileUrl, {
          headers: { 'X-Api-Key': instance.apiKey }
        });
        if (profileRes.ok) {
          var profiles = await profileRes.json();
          for (var p = 0; p < profiles.length; p++) {
            if (profiles[p].name.toLowerCase() === instance.qualityProfile.toLowerCase()) {
              qualityProfileId = profiles[p].id;
              break;
            }
          }
        }
      }
      if (isNaN(qualityProfileId)) {
        qualityProfileId = 1;
      }

      // 3. Resolve rootFolderPath
      var rootFolderPath = instance.rootFolder;
      if (!rootFolderPath) {
        var rootUrl = base + '/api/v3/rootfolder';
        var rootRes = await ctx.fetch(rootUrl, {
          headers: { 'X-Api-Key': instance.apiKey }
        });
        if (rootRes.ok) {
          var folders = await rootRes.json();
          if (folders && folders.length > 0) {
            rootFolderPath = folders[0].path;
          }
        }
      }

      if (!rootFolderPath) return { success: false, error: 'No root folder path configured' };

      // 4. Build add payload
      var addPayload = {
        title: movieDetails.title,
        titleSlug: movieDetails.titleSlug || movieDetails.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        images: movieDetails.images || [],
        tmdbId: parseInt(tmdbId, 10),
        year: movieDetails.year,
        qualityProfileId: qualityProfileId,
        rootFolderPath: rootFolderPath,
        monitored: true,
        addOptions: {
          searchForMovie: true
        }
      };

      // 5. Post to Radarr to add and search
      var addUrl = base + '/api/v3/movie';
      var addRes = await ctx.fetch(addUrl, {
        method: 'POST',
        headers: {
          'X-Api-Key': instance.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(addPayload)
      });

      if (addRes.ok) {
        ctx.notifications.send({
          title: 'Radarr Request Successful',
          body: 'Requested "' + movieDetails.title + '" on ' + instance.name + '.'
        });
        return { passed: true };
      } else {
        var errorData = await addRes.text();
        return { success: false, error: 'Radarr API error: ' + errorData };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Auto-download on watchlist add
  ctx.events.on('otix:list:item_added', async function(payload) {
    if (payload.listId !== 'watchlist') return;
    if (payload.item.mediaType !== 'movie') return;

    var tmdbId = payload.item.mediaItemId;
    if (!tmdbId) return;

    var instances = getInstances();
    for (var i = 0; i < instances.length; i++) {
      var instance = instances[i];
      if (!instance.enabled || !instance.autoRequestWatchlist) continue;

      var base = (instance.useSsl ? 'https' : 'http') + '://' + instance.host + ':' + instance.port + (instance.baseUrl || '');
      try {
        // 1. Search Radarr using tmdbId lookup
        var lookupUrl = base + '/api/v3/movie/lookup/tmdb?tmdbId=' + tmdbId;
        var lookupRes = await ctx.fetch(lookupUrl, {
          headers: { 'X-Api-Key': instance.apiKey }
        });
        if (!lookupRes.ok) {
          ctx.logger.error('Radarr lookup failed for TMDB ID ' + tmdbId + ' on ' + instance.name + ': HTTP ' + lookupRes.status);
          continue;
        }
        var movieDetails = await lookupRes.json();
        if (!movieDetails) {
          ctx.logger.error('No movie details found for TMDB ID ' + tmdbId + ' on ' + instance.name);
          continue;
        }

        // Check if movie already exists in Radarr
        if (movieDetails.id) {
          ctx.logger.info('Movie "' + movieDetails.title + '" already exists in Radarr instance ' + instance.name);
          continue;
        }

        // 2. Resolve qualityProfileId
        var qualityProfileId = parseInt(instance.qualityProfile, 10);
        if (isNaN(qualityProfileId)) {
          var profileUrl = base + '/api/v3/qualityprofile';
          var profileRes = await ctx.fetch(profileUrl, {
            headers: { 'X-Api-Key': instance.apiKey }
          });
          if (profileRes.ok) {
            var profiles = await profileRes.json();
            for (var p = 0; p < profiles.length; p++) {
              if (profiles[p].name.toLowerCase() === instance.qualityProfile.toLowerCase()) {
                qualityProfileId = profiles[p].id;
                break;
              }
            }
          }
        }
        if (isNaN(qualityProfileId)) {
          qualityProfileId = 1; // Default fallback to profile ID 1
        }

        // 3. Resolve rootFolderPath
        var rootFolderPath = instance.rootFolder;
        if (!rootFolderPath) {
          var rootUrl = base + '/api/v3/rootfolder';
          var rootRes = await ctx.fetch(rootUrl, {
            headers: { 'X-Api-Key': instance.apiKey }
          });
          if (rootRes.ok) {
            var folders = await rootRes.json();
            if (folders && folders.length > 0) {
              rootFolderPath = folders[0].path;
            }
          }
        }

        if (!rootFolderPath) {
          ctx.logger.error('Cannot add movie: No root folder path configured or found on ' + instance.name);
          continue;
        }

        // 4. Build add payload
        var addPayload = {
          title: movieDetails.title,
          titleSlug: movieDetails.titleSlug || movieDetails.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          images: movieDetails.images || [],
          tmdbId: parseInt(tmdbId, 10),
          year: movieDetails.year,
          qualityProfileId: qualityProfileId,
          rootFolderPath: rootFolderPath,
          monitored: true,
          addOptions: {
            searchForMovie: true
          }
        };

        // 5. Post to Radarr to add and search
        var addUrl = base + '/api/v3/movie';
        var addRes = await ctx.fetch(addUrl, {
          method: 'POST',
          headers: {
            'X-Api-Key': instance.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(addPayload)
        });

        if (addRes.ok) {
          ctx.logger.info('Successfully added movie "' + movieDetails.title + '" to Radarr instance ' + instance.name + ' and started download search.');
          ctx.notifications.send({
            title: 'Radarr Download Started',
            body: 'Added "' + movieDetails.title + '" to ' + instance.name + '.'
          });
        } else {
          var errorData = await addRes.text();
          ctx.logger.error('Failed to add movie to Radarr ' + instance.name + ': HTTP ' + addRes.status + ' - ' + errorData);
        }
      } catch (e) {
        ctx.logger.error('Error adding movie to Radarr instance ' + instance.name + ': ' + e.message);
      }
    }
  });
};

main.status = async function(ctx) {
  var STORAGE_KEY = 'instances';
  var instances = ctx.config.get(STORAGE_KEY) || [];
  var enabled = instances.filter(function(i) { return i.enabled; });
  return {
    connected: enabled.length > 0,
    configured: instances.length > 0,
    enabled_count: enabled.length,
  };
};

main.test = async function(ctx) {
  var STORAGE_KEY = 'instances';
  var instances = ctx.config.get(STORAGE_KEY) || [];
  var enabled = instances.filter(function(i) { return i.enabled; });
  if (enabled.length === 0) {
    return { passed: false, failures: ['No enabled Radarr instances to test.'] };
  }
  var successCount = 0;
  var errors = [];
  for (var i = 0; i < enabled.length; i++) {
    var instance = enabled[i];
    var base = (instance.useSsl ? 'https' : 'http') + '://' + instance.host + ':' + instance.port + (instance.baseUrl || '');
    try {
      var response = await ctx.fetch(base + '/api/v3/system/status', {
        headers: { 'X-Api-Key': instance.apiKey },
      });
      if (response.ok) {
        successCount++;
      } else {
        errors.push(instance.name + ': HTTP ' + response.status);
      }
    } catch (e) {
      errors.push(instance.name + ': ' + e.message);
    }
  }
  if (successCount === enabled.length) {
    return { passed: true };
  } else {
    return { passed: false, failures: ['Connected to ' + successCount + '/' + enabled.length + ' instances. Errors: ' + errors.join(', ')] };
  }
};

main.slotRender = async function(ctx, location, context) {
  if (location !== 'media/detail/actions') return null;
  if (context.mediaType !== 'movie') return null;

  var STORAGE_KEY = 'instances';
  var instances = ctx.config.get(STORAGE_KEY) || [];
  var enabled = instances.filter(function(i) { return i.enabled; });
  if (enabled.length === 0) return null;

  var tmdbId = context.mediaId;
  var statusMap = {};
  var existsAny = false;
  for (var i = 0; i < enabled.length; i++) {
    var instance = enabled[i];
    var base = (instance.useSsl ? 'https' : 'http') + '://' + instance.host + ':' + instance.port + (instance.baseUrl || '');
    try {
      var response = await ctx.fetch(base + '/api/v3/movie/lookup/tmdb?tmdbId=' + tmdbId, {
        headers: { 'X-Api-Key': instance.apiKey }
      });
      if (response.ok) {
        var details = await response.json();
        if (details && details.id) {
          statusMap[instance.id] = 'exists';
          existsAny = true;
        } else {
          statusMap[instance.id] = 'not_exists';
        }
      } else {
        statusMap[instance.id] = 'error';
      }
    } catch (e) {
      statusMap[instance.id] = 'error';
    }
  }

  return {
    widgets: [
      {
        type: 'request-button',
        props: {
          label: existsAny ? 'In Library' : 'Request Movie',
          mediaType: 'movie',
          mediaId: tmdbId,
          instances: enabled.map(function(i) {
            return { id: i.id, name: i.name, status: statusMap[i.id] || 'error' };
          })
        }
      }
    ]
  };
};

module.exports = main;
