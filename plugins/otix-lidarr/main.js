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
      var response = await ctx.fetch(base + '/api/v1/system/status', {
        headers: { 'X-Api-Key': instance.apiKey },
      });
      if (!response.ok) return { ok: false, message: 'HTTP ' + response.status };
      var data = await response.json();
      return { ok: true, message: 'Lidarr v' + (data.version || '?') };
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
        var response = await ctx.fetch(base + '/api/v1/album', {
          headers: { 'X-Api-Key': instance.apiKey }
        });
        if (!response.ok) {
          results.push({
            name: instance.name,
            url: base,
            count: 0,
            albums: [],
            error: 'HTTP ' + response.status
          });
          continue;
        }
        var albums = await response.json();
        results.push({
          name: instance.name,
          url: base,
          count: albums.length,
          albums: albums.map(function(a) {
            var year = a.releaseDate ? new Date(a.releaseDate).getFullYear() : undefined;
            return {
              id: a.id,
              title: a.title,
              year: year,
              images: a.images ? a.images.map(function(img) {
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
          albums: [],
          error: e.message || String(e)
        });
      }
    }
    return results;
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
    return { passed: false, failures: ['No enabled Lidarr instances to test.'] };
  }
  var successCount = 0;
  var errors = [];
  for (var i = 0; i < enabled.length; i++) {
    var instance = enabled[i];
    var base = (instance.useSsl ? 'https' : 'http') + '://' + instance.host + ':' + instance.port + (instance.baseUrl || '');
    try {
      var response = await ctx.fetch(base + '/api/v1/system/status', {
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

module.exports = main;
