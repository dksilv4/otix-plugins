module.exports = function(ctx) {
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
};
