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
      return { ok: true, message: 'Sonarr v' + (data.version || '?') };
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
        var response = await ctx.fetch(base + '/api/v3/series', {
          headers: { 'X-Api-Key': instance.apiKey }
        });
        if (!response.ok) {
          results.push({
            name: instance.name,
            url: base,
            count: 0,
            series: [],
            error: 'HTTP ' + response.status
          });
          continue;
        }
        var series = await response.json();
        results.push({
          name: instance.name,
          url: base,
          count: series.length,
          series: series.map(function(s) {
            return {
              id: s.id,
              title: s.title,
              year: s.year,
              images: s.images ? s.images.map(function(img) {
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
          series: [],
          error: e.message || String(e)
        });
      }
    }
    return results;
  });

  // Watchlist manual request handler
  ctx.handle('request-series', async function(args) {
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
      // 1. Search Sonarr using tmdbId lookup
      var lookupUrl = base + '/api/v3/series/lookup?term=tmdb:' + tmdbId;
      var lookupRes = await ctx.fetch(lookupUrl, {
        headers: { 'X-Api-Key': instance.apiKey }
      });
      if (!lookupRes.ok) return { success: false, error: 'Sonarr lookup failed: HTTP ' + lookupRes.status };
      var searchResults = await lookupRes.json();
      if (!searchResults || searchResults.length === 0) return { success: false, error: 'No show details found' };
      var showDetails = searchResults[0];

      if (showDetails.id) return { passed: true };

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
        title: showDetails.title,
        titleSlug: showDetails.titleSlug || showDetails.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        images: showDetails.images || [],
        tvdbId: showDetails.tvdbId,
        year: showDetails.year,
        qualityProfileId: qualityProfileId,
        rootFolderPath: rootFolderPath,
        monitored: true,
        seasons: showDetails.seasons ? showDetails.seasons.map(function(s) {
          return { seasonNumber: s.seasonNumber, monitored: true };
        }) : [],
        addOptions: {
          searchForMissingEpisodes: true
        }
      };

      // 5. Post to Sonarr to add and search
      var addUrl = base + '/api/v3/series';
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
          title: 'Sonarr Request Successful',
          body: 'Requested "' + showDetails.title + '" on ' + instance.name + '.'
        });
        return { passed: true };
      } else {
        var errorData = await addRes.text();
        return { success: false, error: 'Sonarr API error: ' + errorData };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Auto-download on watchlist add
  ctx.events.on('otix:list:item_added', async function(payload) {
    if (payload.listId !== 'watchlist') return;
    if (payload.item.mediaType !== 'tv' && payload.item.mediaType !== 'show') return;

    var tmdbId = payload.item.mediaItemId;
    if (!tmdbId) return;

    var instances = getInstances();
    for (var i = 0; i < instances.length; i++) {
      var instance = instances[i];
      if (!instance.enabled || !instance.autoRequestWatchlist) continue;

      var base = (instance.useSsl ? 'https' : 'http') + '://' + instance.host + ':' + instance.port + (instance.baseUrl || '');
      try {
        // 1. Search Sonarr using tmdbId lookup (Sonarr v3 lookup supports tmdb:ID)
        var lookupUrl = base + '/api/v3/series/lookup?term=tmdb:' + tmdbId;
        var lookupRes = await ctx.fetch(lookupUrl, {
          headers: { 'X-Api-Key': instance.apiKey }
        });
        if (!lookupRes.ok) {
          ctx.logger.error('Sonarr lookup failed for TMDB ID ' + tmdbId + ' on ' + instance.name + ': HTTP ' + lookupRes.status);
          continue;
        }
        var searchResults = await lookupRes.json();
        if (!searchResults || searchResults.length === 0) {
          ctx.logger.error('No show details found for TMDB ID ' + tmdbId + ' on ' + instance.name);
          continue;
        }
        var showDetails = searchResults[0];

        // Check if show already exists in Sonarr
        if (showDetails.id) {
          ctx.logger.info('Show "' + showDetails.title + '" already exists in Sonarr instance ' + instance.name);
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
          ctx.logger.error('Cannot add show: No root folder path configured or found on ' + instance.name);
          continue;
        }

        // 4. Build add payload
        var addPayload = {
          title: showDetails.title,
          titleSlug: showDetails.titleSlug || showDetails.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          images: showDetails.images || [],
          tvdbId: showDetails.tvdbId,
          year: showDetails.year,
          qualityProfileId: qualityProfileId,
          rootFolderPath: rootFolderPath,
          monitored: true,
          seasons: showDetails.seasons ? showDetails.seasons.map(function(s) {
            return { seasonNumber: s.seasonNumber, monitored: true };
          }) : [],
          addOptions: {
            searchForMissingEpisodes: true
          }
        };

        // 5. Post to Sonarr to add and search
        var addUrl = base + '/api/v3/series';
        var addRes = await ctx.fetch(addUrl, {
          method: 'POST',
          headers: {
            'X-Api-Key': instance.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(addPayload)
        });

        if (addRes.ok) {
          ctx.logger.info('Successfully added show "' + showDetails.title + '" to Sonarr instance ' + instance.name + ' and started download search.');
          ctx.notifications.send({
            title: 'Sonarr Download Started',
            body: 'Added "' + showDetails.title + '" to ' + instance.name + '.'
          });
        } else {
          var errorData = await addRes.text();
          ctx.logger.error('Failed to add show to Sonarr ' + instance.name + ': HTTP ' + addRes.status + ' - ' + errorData);
        }
      } catch (e) {
        ctx.logger.error('Error adding show to Sonarr instance ' + instance.name + ': ' + e.message);
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
    return { passed: false, failures: ['No enabled Sonarr instances to test.'] };
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
  if (context.mediaType !== 'show' && context.mediaType !== 'tv') return null;

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
      var response = await ctx.fetch(base + '/api/v3/series/lookup?term=tmdb:' + tmdbId, {
        headers: { 'X-Api-Key': instance.apiKey }
      });
      if (response.ok) {
        var results = await response.json();
        if (results && results.length > 0 && results[0].id) {
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
          label: existsAny ? 'In Library' : 'Request Show',
          mediaType: 'show',
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
