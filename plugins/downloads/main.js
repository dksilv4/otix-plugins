var qf = require('./quality-filter');
var organizer = require('./organizer');

module.exports = function(ctx) {
  // ── search-and-download ──
  ctx.handle('search-and-download', async function(args) {
    var providers = await ctx.discover('search-provider');
    if (!providers || providers.length === 0) return { error: 'No search providers available' };
    var downloaders = await ctx.discover('downloader');
    if (!downloaders || downloaders.length === 0) return { error: 'No downloaders available' };

    var config = ctx.config.getAll();
    var provider = providers[0];
    var downloader = downloaders.find(function(d) { return d.protocol === provider.protocol; }) || downloaders[0];
    if (!downloader) return { error: 'No downloader matching protocol: ' + provider.protocol };

    var results = await ctx.call(provider.pluginId, 'search', { query: args.query });
    if (!results || results.length === 0) return { error: 'No results found for "' + args.query + '"' };

    var allowHv = args.allowHypervisor || config.allowHypervisor || false;
    var best = qf.autoPickBest(results, config.preferredRepackers, allowHv);
    if (!best) return { error: 'No quality releases found for "' + args.query + '"' };

    var dlResult = await ctx.call(downloader.pluginId, 'add-download', {
      downloadUrl: best.downloadUrl, title: best.title,
    });

    return { downloadId: dlResult.id, result: best };
  });

  // ── poll-queue ──
  ctx.handle('poll-queue', async function() {
    var downloaders = await ctx.discover('downloader');
    var queues = await Promise.all(downloaders.map(function(d) {
      return ctx.call(d.pluginId, 'get-queue');
    }));
    var flat = [];
    for (var i = 0; i < queues.length; i++) {
      if (queues[i] && Array.isArray(queues[i])) flat = flat.concat(queues[i]);
    }
    return flat;
  });

  // ── poll-history ──
  ctx.handle('poll-history', async function() {
    var downloaders = await ctx.discover('downloader');
    var histories = await Promise.all(downloaders.map(function(d) {
      return ctx.call(d.pluginId, 'get-history');
    }));
    var flat = [];
    for (var i = 0; i < histories.length; i++) {
      if (histories[i] && Array.isArray(histories[i])) flat = flat.concat(histories[i]);
    }
    return flat;
  });

  // ── test-connections ──
  ctx.handle('test-connections', async function() {
    var results = {};
    var providers = await ctx.discover('search-provider');
    for (var i = 0; i < providers.length; i++) {
      results[providers[i].pluginId] = await ctx.call(providers[i].pluginId, 'test-connection');
    }
    var downloaders = await ctx.discover('downloader');
    for (var j = 0; j < downloaders.length; j++) {
      results[downloaders[j].pluginId] = await ctx.call(downloaders[j].pluginId, 'test-connection');
    }
    return results;
  });

  // ── post-process ──
  ctx.handle('post-process', async function(args) {
    var config = ctx.config.getAll();
    var template = args.namingTemplate || config.namingTemplate || '{Title} ({Year}) [{Platform}]/{OriginalName}.{ext}';
    var dest = args.destPath || config.savePath || args.downloadPath;
    return organizer.autoOrganizeDownload(args.downloadPath, template, dest);
  });

  // ── get-providers ──
  ctx.handle('get-providers', async function() {
    var providers = await ctx.discover('search-provider');
    var downloaders = await ctx.discover('downloader');
    return { providers: providers, downloaders: downloaders };
  });

  // ── get-downloads — reads from shared downloads DB ──
  ctx.handle('get-downloads', async function() {
    try {
      return await ctx.downloadsDb.all('SELECT * FROM downloads ORDER BY created_at DESC');
    } catch(e) {
      return [];
    }
  });

  // ── activity.poll — returns download queue as activity items ──
  ctx.handle('activity.poll', async function() {
    try {
      var downloaders = await ctx.discover('downloader');
      var queues = await Promise.all(downloaders.map(function(d) {
        return ctx.call(d.pluginId, 'get-queue');
      }));
      var histories = await Promise.all(downloaders.map(function(d) {
        return ctx.call(d.pluginId, 'get-history');
      }));

      var items = [];
      var flatQueue = [];
      for (var i = 0; i < queues.length; i++) {
        if (queues[i] && Array.isArray(queues[i])) flatQueue = flatQueue.concat(queues[i]);
      }
      var flatHistory = [];
      for (var j = 0; j < histories.length; j++) {
        if (histories[j] && Array.isArray(histories[j])) flatHistory = flatHistory.concat(histories[j]);
      }

      // Active queue items
      for (var k = 0; k < flatQueue.length; k++) {
        var q = flatQueue[k];
        var isActive = q.status === 'Downloading' || q.status === 'downloading';
        items.push({
          id: q.id,
          type: 'download',
          title: q.title || 'Downloading...',
          subtitle: isActive ? (q.size ? formatSize(q.size) : '') : q.status,
          progress: q.percentage || 0,
          status: isActive ? 'active' : 'pending',
          action: { label: 'Cancel', method: 'cancel-download' },
        });
      }

      // Recent completed/failed from history
      for (var l = 0; l < flatHistory.length; l++) {
        var h = flatHistory[l];
        if (h.status === 'Completed' || h.status === 'Failed') {
          items.push({
            id: h.id,
            type: 'download',
            title: h.title || 'Complete',
            subtitle: h.status === 'Completed' ? 'Done' : 'Failed',
            progress: h.status === 'Completed' ? 100 : 0,
            status: h.status === 'Completed' ? 'completed' : 'error',
          });
        }
      }

      return { activities: items.slice(0, 20), label: 'Downloads' };
    } catch(e) {
      return { activities: [], label: 'Downloads' };
    }
  });

  function formatSize(bytes) {
    if (!bytes) return '';
    var gb = bytes / 1073741824;
    return gb.toFixed(1) + ' GB';
  }
};
