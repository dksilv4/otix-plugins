// Deals plugin for Otix
// Queries CheapShark API for 100%-off deals across all supported stores.
// Complements dedicated Epic/Steam plugins by covering GOG, Humble, Fanatical, etc.

const https = require('https');

// ── Store name map ────────────────────────────────────────────────────

const STORE_NAMES = {
  1: 'Steam', 2: 'GamersGate', 3: 'GreenManGaming', 4: 'Amazon',
  5: 'GameStop', 6: 'Direct2Drive', 7: 'GOG', 8: 'Origin',
  9: 'Get Games', 10: 'Shiny Loot', 11: 'Humble Store', 12: 'Desura',
  13: 'Uplay', 14: 'IndieGameStand', 15: 'Fanatical', 16: 'Gamesrocket',
  17: 'Games Republic', 18: 'SilaGames', 19: 'Playfield', 20: 'ImperialGames',
  21: 'WinGameStore', 22: 'FunStock', 23: 'GameBillet', 24: 'Voidu',
  25: 'Epic Games Store', 26: 'Razer', 27: 'Gamesplanet', 28: 'Gamesload',
  29: '2Game', 30: 'IndieGala', 31: 'Blizzard', 32: 'AllYouPlay',
  33: 'DLGamer', 34: 'Noctre', 35: 'DreamGame',
};

const STORE_URLS = {
  1: 'https://store.steampowered.com/app/', 7: 'https://www.gog.com/game/',
  11: 'https://www.humblebundle.com/store/', 13: 'https://store.ubi.com/',
  15: 'https://www.fanatical.com/game/', 25: 'https://www.epicgames.com/store/p/',
  30: 'https://www.indiegala.com/store/game/', 31: 'https://us.shop.battle.net/product/',
};

// ── HTTP Helpers ──────────────────────────────────────────────────────

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Otix/0.3 (https://github.com/dksilv4/otix-plugins)',
        ...opts.headers,
      },
    };
    const req = https.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: [] });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 15000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

// ── CheapShark API ────────────────────────────────────────────────────

/**
 * Fetch all 100%-off deals from CheapShark.
 * upperPrice=0 means free games only.
 */
async function fetchCheapSharkDeals() {
  const url = 'https://www.cheapshark.com/api/1.0/deals?upperPrice=0&pageSize=60&sortBy=recent';
  const { status, data } = await fetchJson(url, { timeout: 15000 });
  if (status !== 200) {
    throw new Error('CheapShark API returned ' + status);
  }
  if (!Array.isArray(data)) return [];
  return data;
}

function formatDeal(deal) {
  const storeId = deal.storeID;
  const storeName = STORE_NAMES[storeId] || ('Store ' + storeId);
  const normalPrice = deal.normalPrice ? '$' + parseFloat(deal.normalPrice).toFixed(2) : null;
  const thumb = deal.thumb ? 'https://www.cheapshark.com' + deal.thumb : null;

  return {
    id: deal.dealID,
    title: deal.title,
    storeId,
    storeName,
    posterUrl: thumb,
    originalPrice: normalPrice,
    freeEndDate: null, // CheapShark doesn't provide end dates
    urlSlug: deal.dealID,
    description: null,
    seller: storeName,
    // Construct a store URL if we know the pattern
    storeUrl: deal.storeID === 1
      ? STORE_URLS[1] + deal.steamAppID
      : (STORE_URLS[storeId] || null),
    steamAppId: deal.steamAppID || null,
  };
}

// ── Deals Check ───────────────────────────────────────────────────────

let _cache = { deals: [], fetchedAt: 0 };

async function checkDeals(ctx) {
  ctx.logger.info('Checking CheapShark for free deals...');

  let deals;
  try {
    const raw = await fetchCheapSharkDeals();
    deals = raw.map(formatDeal);
  } catch (err) {
    ctx.logger.error('CheapShark check failed: ' + err.message);
    return { success: false, error: err.message, deals: [] };
  }

  ctx.logger.info('CheapShark free deals found: ' + deals.length);

  // Detect new deals (not in last check)
  const lastRaw = await ctx.config.get('_last_free_deals');
  let lastDeals = [];
  try { if (lastRaw) lastDeals = JSON.parse(lastRaw); } catch {}
  const lastIds = new Set(lastDeals.map(d => d.id));
  const newDeals = deals.filter(d => !lastIds.has(d.id));

  // Notify for new deals
  if (newDeals.length > 0) {
    const notify = await ctx.config.get('notify');
    if (notify !== false) {
      const names = newDeals.map(d => '[' + d.storeName + '] ' + d.title).join(', ');
      ctx.notifications.send({
        title: '🎮 Free Game Deals',
        body: newDeals.length + ' new free deal' + (newDeals.length > 1 ? 's' : '') + ': ' + names,
      });
    }
  }

  _cache = { deals, fetchedAt: Date.now() };
  await ctx.config.set('_last_free_deals', JSON.stringify(deals));
  await ctx.config.set('_last_free_deals_check', Date.now());

  return { success: true, deals, newDeals };
}

// ── Plugin exports ────────────────────────────────────────────────────

module.exports = {
  plugin: (ctx) => {
    ctx.logger.info('Deals plugin loaded');

    ctx.config.get('auto_check').then((autoCheck) => {
      if (autoCheck !== false) {
        ctx.logger.info('Auto-checking free deals...');
        checkDeals(ctx).catch(err =>
          ctx.logger.error('Deals check failed: ' + err.message)
        );
      }
    });

    return () => { ctx.logger.info('Deals plugin unloaded'); };
  },

  data: {
    'free.check': async (ctx) => {
      return checkDeals(ctx);
    },

    'activity.poll': async (ctx) => {
      const activities = [];
      const now = Date.now();

      const lastCheck = await ctx.config.get('_last_free_deals_check');
      const stale = lastCheck ? (now - lastCheck) > 30 * 60 * 1000 : true;
      const lastRaw = await ctx.config.get('_last_free_deals');
      let cached = [];
      try { if (lastRaw) cached = JSON.parse(lastRaw); } catch {}

      if (cached.length > 0 && !stale) {
        const names = cached.map(d => '[' + d.storeName + '] ' + d.title).join(', ');
        activities.push({
          id: 'deals-free',
          type: 'promotion',
          title: cached.length + ' free game deal' + (cached.length > 1 ? 's' : ''),
          subtitle: names.length > 80 ? names.slice(0, 77) + '...' : names,
          status: 'completed',
          timestamp: lastCheck || now,
          action: { label: 'Check', method: 'free.check' },
        });
      } else {
        activities.push({
          id: 'deals-free',
          type: 'info',
          title: 'Free Game Deals',
          subtitle: cached.length === 0 ? 'No free deals right now' : 'Check for free deals',
          status: 'pending',
          timestamp: now,
          action: { label: 'Check Now', method: 'free.check' },
        });
      }

      return { activities, label: 'Deals' };
    },

    slotRender: async (ctx, location) => ({
      type: 'free-games',
      platform: 'deals',
      label: 'Free Game Deals',
      description: 'Free game deals from 35 stores via CheapShark',
      mediaTypes: ['games'],
    }),
  },

  status: async (ctx) => {
    const lastCheck = await ctx.config.get('_last_free_deals_check');
    const lastRaw = await ctx.config.get('_last_free_deals');
    let cachedCount = 0;
    try { if (lastRaw) cachedCount = JSON.parse(lastRaw).length; } catch {}
    return {
      connected: true,
      last_check: lastCheck || null,
      cached_deals: cachedCount,
    };
  },

  test: async (ctx) => {
    try {
      const raw = await fetchCheapSharkDeals();
      const byStore = {};
      for (const d of raw) {
        const name = STORE_NAMES[d.storeID] || ('Store ' + d.storeID);
        byStore[name] = (byStore[name] || 0) + 1;
      }
      const summary = Object.entries(byStore).map(([k,v]) => `${k}: ${v}`).join(', ');
      return { passed: true };
    } catch (err) {
      return { passed: false, failures: [err.message] };
    }
  },

  slotRender: async (ctx, location) => ({
    type: 'free-games',
    platform: 'deals',
    label: 'Free Game Deals',
    description: 'Free game deals from 35 stores via CheapShark',
    mediaTypes: ['games'],
  }),
};
