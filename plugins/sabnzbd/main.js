function sabnzbdUrl(host, port, useSsl, mode, extraParams) {
  const scheme = useSsl ? 'https' : 'http';
  const url = new URL(scheme + '://' + host + ':' + port + '/api');
  url.searchParams.set('output', 'json');
  url.searchParams.set('mode', mode);
  for (const [k, v] of Object.entries(extraParams || {})) url.searchParams.set(k, v);
  return url.toString();
}

module.exports = function(ctx) {
  // ── add-download ──
  ctx.handle('add-download', async function(args) {
    const config = ctx.config.getAll();
    const url = sabnzbdUrl(
      config.host, config.port, config.useSsl,
      'addurl', {
        apikey: config.apiKey,
        name: args.downloadUrl,
        nzbname: args.title,
        cat: args.category || config.category || 'games',
      },
    );
    const response = await ctx.fetch(url);
    const data = await response.json();
    if (data && data.nzo_ids && data.nzo_ids[0]) return { id: data.nzo_ids[0] };
    throw new Error('Failed to add NZB to SABnzbd: ' + JSON.stringify(data));
  });

  // ── get-queue ──
  ctx.handle('get-queue', async function() {
    const config = ctx.config.getAll();
    const url = sabnzbdUrl(config.host, config.port, config.useSsl, 'queue', { apikey: config.apiKey });
    try {
      const response = await ctx.fetch(url);
      const data = await response.json();
      const slots = (data && data.queue && data.queue.slots) || [];
      return slots.map(function(s) { return {
        id: s.nzo_id || '',
        title: s.filename || '',
        status: s.status || '',
        percentage: parseFloat(s.percentage || '0'),
        size: parseInt(s.size || '0', 10),
        downloaded: parseInt(s.sizeleft || '0', 10),
      };});
    } catch(e) { return []; }
  });

  // ── get-history ──
  ctx.handle('get-history', async function(args) {
    const config = ctx.config.getAll();
    const url = sabnzbdUrl(config.host, config.port, config.useSsl, 'history', {
      apikey: config.apiKey, limit: String((args && args.limit) || 50),
    });
    try {
      const response = await ctx.fetch(url);
      const data = await response.json();
      const slots = (data && data.history && data.history.slots) || [];
      return slots.map(function(s) { return {
        id: s.nzo_id || '',
        title: s.name || '',
        size: parseInt(s.size || '0', 10),
        status: s.status || '',
        storagePath: s.storage || '',
        completedAt: s.completed ? new Date(s.completed * 1000).toISOString() : '',
      };});
    } catch(e) { return []; }
  });

  // ── remove-download ──
  ctx.handle('remove-download', async function(args) {
    const config = ctx.config.getAll();
    const url = sabnzbdUrl(config.host, config.port, config.useSsl, 'queue', {
      apikey: config.apiKey, name: 'delete', value: args.id,
    });
    const response = await ctx.fetch(url);
    const data = await response.json();
    return data && data.status === true;
  });

  // ── test-connection ──
  ctx.handle('test-connection', async function() {
    try {
      const config = ctx.config.getAll();
      const url = sabnzbdUrl(config.host, config.port, config.useSsl, 'version', { apikey: config.apiKey });
      const response = await ctx.fetch(url);
      const data = await response.json();
      return { ok: !!(data && data.version), message: data && data.version ? 'SABnzbd v' + data.version : 'No version response' };
    } catch(e) {
      return { ok: false, message: e.message };
    }
  });
};
