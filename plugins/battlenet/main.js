// Battle.net Scanner plugin for Otix
// Fetches your full Battle.net game library without needing the desktop app installed.
// Uses Blizzard's internal account API with a session token extracted from the web login.
//
// How it works:
// 1. Opens account.battle.net in a browser window for you to sign in
// 2. After login, extracts the access token from the web session
// 3. Calls Blizzard's internal profile API to get all owned games
// 4. Matches games against the Otix catalog
//
// No manual setup needed — just click "Sign In" and log into your Blizzard account.
//

const https = require('https');

// ── API Constants ─────────────────────────────────────────────────────

const PROFILE_HOST = 'profile-api.battle.net';
const CATALOG_HOST = 'us.catalog.battle.net';

const UA = 'Otix/1.0 (Battle.net Scanner)';

// ── Product Code → Game Title map (fallback when catalog API unavailable) ──

const PRODUCT_NAMES = {
  WOW:  'World of Warcraft',
  D3:   'Diablo III',
  S2:   'StarCraft II',
  S1:   'StarCraft Remastered',
  HS:   'Hearthstone',
  HERO: 'Heroes of the Storm',
  OW:   'Overwatch',
  PRO:  'Overwatch 2',
  ODIN: 'Diablo II: Resurrected',
  FEN:  'Diablo IV',
  W3:   'Warcraft III: Reforged',
  OSI:  'Call of Duty: Modern Warfare',
  OBV:  'Call of Duty: Black Ops Cold War',
  ZMX:  'Call of Duty: Vanguard',
  W2:   'Call of Duty: Modern Warfare II',
  W3G:  'Call of Duty: Modern Warfare III',
  CPB:  'Call of Duty: Black Ops 6',
  FEB:  'World of Warcraft: Cataclysm Classic',
  WLK:  'World of Warcraft: Wrath of the Lich King Classic',
};

// ── HTTP Helpers ──────────────────────────────────────────────────────

function fetchJson(host, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      port: 443,
      path: pathname,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        ...(opts.headers || {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: body ? JSON.parse(body) : null, headers: res.headers }); }
        catch { resolve({ status: res.statusCode, data: body, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 30000, () => { req.destroy(); reject(new Error('Timed out')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function callApi(token, host, path, useCookies) {
  const headers = {};
  if (useCookies || _authType === 'cookies') {
    headers['Cookie'] = _storedCookies;
  } else {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetchJson(host, path, { headers });
}

// ── Token Management ──────────────────────────────────────────────────

let _token = null;
let _authType = 'bearer';  // 'bearer' or 'cookies'
let _storedCookies = null;

function _clearAuth(ctx) {
  _token = null;
  _authType = 'bearer';
  _storedCookies = null;
  ctx.config.set('access_token', '');
  ctx.config.set('access_cookies', '');
}

async function _ensureToken(ctx) {
  // Cached
  if (_token) return _token;

  // Stored token from a previous session
  const stored = await ctx.config.get('access_token');
  if (stored) {
    if (stored === '__cookie_auth__') {
      // Cookie-based auth — restore cookies and validate via account API
      if (!_storedCookies) {
        _storedCookies = await ctx.config.get('access_cookies');
      }
      if (!_storedCookies) {
        _clearAuth(ctx);
        return null;
      }
      const products = await _fetchProductsFromAccountApi(ctx);
      if (products && products.length > 0) {
        _token = stored;
        _authType = 'cookies';
        return _token;
      }
      _clearAuth(ctx);
      return null;
    }

    // Quick validation — check userinfo endpoint
    const u = await callApi(stored, PROFILE_HOST, '/userinfo').catch(() => null);
    if (u && u.status === 200) {
      _token = stored;
      return _token;
    }
    // Token expired — clear it
    _clearAuth(ctx);
  }

  return null;
}

// ── Cookie-Based Auth ────────────────────────────────────────────────

const BNET_CLIENT_ID = '057adb2af62a4d59904f74754838c4c8';
const OAUTH_HOST = 'oauth.battle.net';

function _postForm(host, path, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: host,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': UA,
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, data: null, headers: res.headers }); }
      });
    });
    req.on('error', () => resolve({ status: 0, data: null, headers: {} }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, data: null, headers: {} }); });
    if (body) req.write(body);
    req.end();
  });
}

function _extractXsrf(cookies) {
  const m = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return m ? m[1] : null;
}

async function _fetchProductsFromAccountApi(ctx) {
  const xsrfToken = _extractXsrf(_storedCookies);
  const headers = {
    'Cookie': _storedCookies,
    'User-Agent': UA,
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://account.battle.net/',
    'Accept': 'application/json',
  };
  if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken;

  // account.battle.net API endpoints that might return product/game data.
  // The SPA uses these with session cookies; the backend adds the Bearer token
  // server-side before proxying to profile-api.battle.net.
  // SPA calls observed from CDP logs
  const endpoints = [
    '/api/overview',
    '/api/details',
    '/api/time-gated-games',
    '/api/external-subs',
    '/api/transactions',
    '/api/games',
    '/api/products',
    '/api/entitlements',
    '/api/library',
  ];

  for (const ep of endpoints) {
    try {
      ctx.logger.debug('Trying ' + ep);
      const res = await fetchJson('account.battle.net', ep, { headers, timeout: 10000 });
      ctx.logger.debug(ep + ' -> ' + res.status);
      if (res.status !== 200 || !res.data) continue;

      // Log the full body so we can see the complete data structure
      ctx.logger.info(ep + ' body: ' + JSON.stringify(res.data).slice(0, 2000));

      // Try to extract product/game arrays from various response shapes
      const candidates = Array.isArray(res.data) ? res.data
        : (res.data.products || res.data.games || res.data.items || res.data.entitlements || res.data.result || null);

      const items = Array.isArray(candidates) ? candidates
        : (candidates && typeof candidates === 'object' ? Object.values(candidates).filter(v => v && typeof v === 'object') : null);

      if (Array.isArray(items) && items.length > 0) {
        // Filter for items that look like game products
        const products = items.filter(p =>
          p && typeof p === 'object' && (p.product_code || p.uid || p.productCode || p.name || p.title)
        );
        if (products.length > 0) return products;
      }
    } catch (e) {
      ctx.logger.debug(ep + ' error: ' + (e.message || e));
    }
  }

  // Fallback: fetch the overview page HTML and look for embedded game data
  ctx.logger.info('Trying HTML embedded state extraction...');
  try {
    const htmlRes = await fetchJson('account.battle.net', '/overview', { timeout: 10000 });
    if (htmlRes.status === 200 && typeof htmlRes.data === 'string') {
      const html = htmlRes.data;
      const patterns = [
        /window\.__INITIAL_STATE__\s*=\s*({.+?});/,
        /window\.__DATA__\s*=\s*({.+?});/,
        /<script[^>]*id="__NEXT_DATA__"[^>]*>({.+?})<\/script>/,
      ];
      for (const pat of patterns) {
        const m = html.match(pat);
        if (m) {
          ctx.logger.info('Found embedded state via regex');
          try {
            const state = JSON.parse(m[1]);
            const candidates = state.products || state.games || state.user?.games || state.account?.products
              || state.data?.products || state.props?.pageProps?.products || null;
            if (Array.isArray(candidates) && candidates.length > 0) {
              const items = candidates.filter(p => p && typeof p === 'object' && (p.product_code || p.uid || p.name));
              if (items.length > 0) return items;
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    ctx.logger.debug('HTML extraction error: ' + (e.message || e));
  }

  return null;
}

// ── Game List Building ──────────────────────────────────────────────

function _convertProductsToGames(products, catalogMap) {
  const games = [];
  for (const product of products) {
    const code = product.product_code || product.uid || '';
    const catalogEntry = catalogMap?.[code];
    const rawTitle = product.name || product.product_name || product.title || catalogEntry?.name || catalogEntry?.title || '';
    const title = rawTitle || PRODUCT_NAMES[code] || code || 'Unknown Game';

    const externalIds = [{ source: 'battlenet', id: code }];
    if (product.uid && product.uid !== code) {
      externalIds.push({ source: 'battlenet_uid', id: product.uid });
    }

    games.push({
      id: code || ('bnet_' + title.toLowerCase().replace(/[^a-z0-9]/g, '_')),
      title,
      platform: 'battlenet',
      externalIds,
      developer: 'Blizzard Entertainment',
      publisher: 'Blizzard Entertainment',
      installPath: null,
      exePath: null,
      posterUrl: catalogEntry?.images?.[0]?.url || catalogEntry?.poster_url || null,
      logoUrl: null,
      dlcOf: product.parent_product_code || null,
      rawMetadata: {
        productCode: code,
        platform: product.platform || null,
        status: product.status || null,
      },
    });
  }
  return games;
}

async function fetchOwnedProducts(token) {
  const { status, data } = await callApi(token, PROFILE_HOST, '/profile/products');
  if (status !== 200) {
    throw new Error(`Profile API returned ${status}${data && typeof data === 'object' && data.error ? ': ' + data.error : ''}`);
  }
  return data?.products || data || [];
}

async function fetchCatalogProducts(_token) {
  // Catalog API is public — no auth needed
  try {
    const { status, data } = await fetchJson(CATALOG_HOST, '/catalog/products');
    if (status === 200 && data?.products) return data.products;
  } catch {}
  return null;
}

// ── Core Scan ─────────────────────────────────────────────────────────

async function performScan(ctx) {
  ctx.logger.info('Starting Battle.net library scan...');

  // Cookie auth mode — use account.battle.net API directly
  if (_authType === 'cookies') {
    const products = await _fetchProductsFromAccountApi(ctx);
    if (!products || !Array.isArray(products) || products.length === 0) {
      ctx.logger.info('No products found via account API');
      return { success: true, total: 0, games: [] };
    }
    ctx.logger.info('Found ' + products.length + ' products via account API');
    // Enrich with public catalog
    let catalogMap = null;
    try {
      const catalog = await fetchCatalogProducts(null);
      if (catalog && Array.isArray(catalog)) {
        catalogMap = {};
        for (const p of catalog) catalogMap[p.product_code || p.uid] = p;
      }
    } catch {}
    const games = _convertProductsToGames(products, catalogMap);
    ctx.logger.info('Battle.net scan complete: ' + games.length + ' games');
    return { success: true, total: games.length, games };
  }

  // Bearer token mode — use profile-api.battle.net
  const token = await _ensureToken(ctx);
  if (!token) {
    return { success: false, error: 'not_authenticated', games: [] };
  }

  let products;
  try {
    products = await fetchOwnedProducts(token);
  } catch (err) {
    ctx.logger.error('Failed to fetch Battle.net products: ' + err.message);
    return { success: false, error: err.message, games: [] };
  }

  if (!products || !Array.isArray(products) || products.length === 0) {
    ctx.logger.info('No products found in Battle.net account');
    return { success: true, total: 0, games: [] };
  }

  ctx.logger.info('Found ' + products.length + ' products');

  // Catalog enrichment
  let catalogMap = null;
  try {
    const catalog = await fetchCatalogProducts(token);
    if (catalog && Array.isArray(catalog)) {
      catalogMap = {};
      for (const p of catalog) catalogMap[p.product_code || p.uid] = p;
    }
  } catch {}

  const games = _convertProductsToGames(products, catalogMap);

  ctx.logger.info('Battle.net scan complete: ' + games.length + ' games');
  return { success: true, total: games.length, games };
}

// ── Data Methods ──────────────────────────────────────────────────────

const dataMethods = {
  // Login flow: open account.battle.net for sign-in, then extract the token
  'auth.getLoginUrl': async () => {
    return {
      url: 'https://account.battle.net/login',
      redirectPattern: 'account.battle.net',
      tokenExtraction: { type: 'web-request', key: '*.battle.net' },
    };
  },

  // After login, the OAuth window captures the page. We extract the token
  // from the account page's web storage / API calls.
  'auth.handleCallback': async (ctx, token) => {
    if (!token) return { success: false, error: 'No token provided' };

    // Check if this is a cookie payload from the OAuth window
    let cookiesData = null;
    try {
      const parsed = JSON.parse(token);
      if (parsed && parsed.type === 'cookies' && parsed.data) {
        cookiesData = parsed.data;
      }
    } catch {}

    if (cookiesData) {
      ctx.logger.info('Received session cookies from OAuth window');

      // Strategy 1: Try OAuth token exchange with correct host + client_id + cookies
      _storedCookies = cookiesData;
      await ctx.config.set('access_cookies', cookiesData);
      try {
        ctx.logger.info('Attempting token exchange at ' + OAUTH_HOST + ' with client_id');
        const exchangeRes = await _postForm(OAUTH_HOST, '/token',
          'grant_type=urn:blizzard:params:oauth:grant-type:implicit-exchange&client_id=' + BNET_CLIENT_ID,
          { 'Cookie': cookiesData }
        );
        ctx.logger.info('Exchange response: ' + exchangeRes.status + ' ' + JSON.stringify(exchangeRes.data).slice(0, 300));
        if (exchangeRes.status === 200 && exchangeRes.data?.access_token) {
          const bt = exchangeRes.data.access_token;
          ctx.logger.info('Token exchange succeeded!');
          _token = bt;
          _authType = 'bearer';
          await ctx.config.set('access_token', bt);
          ctx.notifications.send({ title: 'Battle.net', body: 'Connected' });
          const autoSync = await ctx.config.get('auto_sync');
          if (autoSync !== false) {
            const scanResult = await performScan(ctx);
            return { success: true, scan: scanResult };
          }
          return { success: true };
        }
      } catch (e) {
        ctx.logger.error('Token exchange error: ' + (e.message || e));
      }

      // Strategy 2: Fallback to account API scanning
      ctx.logger.info('Token exchange failed, trying account API...');
      const products = await _fetchProductsFromAccountApi(ctx);
      if (products && products.length > 0) {
        ctx.logger.info('Found ' + products.length + ' products via account API');
        _authType = 'cookies';
        _token = '__cookie_auth__';
        await ctx.config.set('access_token', '__cookie_auth__');
        ctx.notifications.send({ title: 'Battle.net', body: 'Connected' });

        // Enrich with catalog data and build game list
        let catalogMap = null;
        try {
          const catalog = await fetchCatalogProducts(null);
          if (catalog && Array.isArray(catalog)) {
            catalogMap = {};
            for (const p of catalog) catalogMap[p.product_code || p.uid] = p;
          }
        } catch {}

        const games = _convertProductsToGames(products, catalogMap);
        const scanResult = { success: true, total: games.length, games };
        ctx.logger.info('Battle.net scan complete: ' + games.length + ' games');
        return { success: true, scan: scanResult };
      }

      ctx.logger.error('Account API returned no products');
      return { success: false, error: 'Could not authenticate with Battle.net. Try a different approach.' };
    }

    // Direct Bearer token (original flow)
    const v = await callApi(token, PROFILE_HOST, '/userinfo').catch(() => null);
    if (!v || v.status !== 200) {
      return { success: false, error: 'Token validation failed — try signing in again' };
    }
    _token = token;
    await ctx.config.set('access_token', token);
    ctx.logger.info('Authenticated with Battle.net');
    ctx.notifications.send({ title: 'Battle.net', body: 'Connected' });

    const autoSync = await ctx.config.get('auto_sync');
    if (autoSync !== false) {
      const scanResult = await performScan(ctx);
      return { success: true, scan: scanResult };
    }
    return { success: true };
  },

  'auth.logout': async (ctx) => {
    _clearAuth(ctx);
    return { success: true };
  },

  'scan': async (ctx) => {
    const result = await performScan(ctx);
    if (!result.success) {
      return { success: false, error: result.error, games: [] };
    }
    const games = result.games.map((g) => ({
      id: g.id,
      title: g.title,
      platform: 'battlenet',
      externalIds: g.externalIds || [{ source: 'battlenet', id: g.id }],
      developer: g.developer || null,
      publisher: g.publisher || null,
      installPath: null,
      exePath: null,
      posterUrl: g.posterUrl || null,
      logoUrl: null,
      dlcOf: g.dlcOf || null,
      rawMetadata: {
        productCode: g.rawMetadata?.productCode || null,
        platform: g.rawMetadata?.platform || null,
        status: g.rawMetadata?.status || null,
      },
    }));
    return { success: true, total: result.total, games };
  },

  'scan.status': async () => ({ phase: 'idle' }),
};

// ── Plugin Exports ────────────────────────────────────────────────────

module.exports = {
  plugin: (ctx) => {
    ctx.logger.info('Battle.net Scanner loaded');
  },

  data: dataMethods,

  status: async (ctx) => {
    const token = await ctx.config.get('access_token');
    return { connected: !!token };
  },

  test: async (ctx) => {
    const token = await _ensureToken(ctx);
    if (!token) return { passed: false, failures: ['Not connected. Sign in first.'] };
    try {
      const v = await callApi(token, PROFILE_HOST, '/userinfo');
      if (v.status !== 200) return { passed: false, failures: ['Token expired. Sign in again.'] };
      return { passed: true };
    } catch (err) {
      return { passed: false, failures: ['Connection failed: ' + err.message] };
    }
  },

  slotRender: async (ctx, location) => ({
    type: 'scan',
    platform: 'battlenet',
    label: 'Battle.net',
    description: 'Sign in to scan your full Battle.net game library (no app required)',
    mediaTypes: ['games'],
    actions: { scan: 'scan', status: 'scan.status', login: 'auth.getLoginUrl', handleCallback: 'auth.handleCallback', logout: 'auth.logout' },
  }),
};
