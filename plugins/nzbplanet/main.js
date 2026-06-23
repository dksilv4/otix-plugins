// In-memory cache (1 hour TTL)
var searchCache = {};
var CACHE_TTL = 60 * 60 * 1000;

function getCached(query) {
  var key = query.toLowerCase().trim();
  var entry = searchCache[key];
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL) return entry.results;
  return null;
}

function setCached(query, results) {
  var key = query.toLowerCase().trim();
  searchCache[key] = { results: results, fetchedAt: Date.now() };
}

function parseXmlItems(xml) {
  var results = [];
  var itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  var match;
  while ((match = itemRegex.exec(xml)) !== null) {
    var block = match[1];
    var tag = function(name) {
      var m = block.match(new RegExp('<'+name+'[^>]*>([\\s\\S]*?)<\\/'+name+'>', 'i'));
      return m ? m[1].trim() : '';
    };
    results.push({
      id: tag('guid'),
      title: tag('title').replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1'),
      size: parseInt(tag('size'), 10) || 0,
      pubDate: tag('pubDate') || new Date().toISOString(),
      category: tag('category'),
      downloadUrl: tag('link'),
      infoUrl: tag('link'),
      source: 'nzbplanet',
    });
  }
  results.sort(function(a, b) { return b.size - a.size; });
  return results;
}

module.exports = function(ctx) {
  // ── search ──
  ctx.handle('search', async function(args) {
    var config = ctx.config.getAll();
    var apiKey = config.apiKey;
    if (!apiKey) throw new Error('NZBPlanet API key not configured');

    var cached = getCached(args.query);
    if (cached) return cached;

    var categories = args.categories || config.categoryIds || '1000,2000';
    var url = 'https://api.nzbplanet.net/api?t=search&apikey=' + encodeURIComponent(apiKey) +
      '&q=' + encodeURIComponent(args.query) +
      '&cat=' + encodeURIComponent(categories) + '&o=json&num=' + (args.limit || 20);

    var response = await ctx.fetch(url);
    var text = await response.text();
    var results;

    if (text.trim().startsWith('{')) {
      var data = JSON.parse(text);
      var items = data && data.channel && data.channel.item;
      if (!items) return [];
      var itemList = Array.isArray(items) ? items : [items];
      results = itemList.map(function(item) { return {
        id: item.guid || '',
        title: item.title || '',
        size: parseInt(item.size || '0', 10),
        pubDate: item.pubDate || new Date().toISOString(),
        category: item.category || '',
        downloadUrl: item.link || '',
        infoUrl: item.link || '',
        source: 'nzbplanet',
      };});
      results.sort(function(a, b) { return b.size - a.size; });
    } else if (text.includes('<?xml') || text.includes('<rss')) {
      results = parseXmlItems(text);
    } else {
      return [];
    }

    setCached(args.query, results);
    return results;
  });

  // ── test-connection ──
  ctx.handle('test-connection', async function() {
    try {
      var config = ctx.config.getAll();
      var apiKey = config.apiKey;
      if (!apiKey) return { ok: false, message: 'No API key configured' };

      var url = new URL('https://api.nzbplanet.net/api');
      url.searchParams.set('t', 'search');
      url.searchParams.set('apikey', apiKey);
      url.searchParams.set('q', 'test');
      url.searchParams.set('cat', '1000');
      url.searchParams.set('o', 'json');
      url.searchParams.set('num', '1');

      var response = await ctx.fetch(url.toString());
      return { ok: response.ok, message: response.ok ? 'Connection successful' : 'HTTP ' + response.status };
    } catch(e) {
      return { ok: false, message: e.message };
    }
  });

  // ── status ──
  ctx.handle('status', async function() {
    var config = ctx.config.getAll();
    return { configured: !!config.apiKey };
  });
};
