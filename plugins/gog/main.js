// GOG Galaxy Scanner plugin for Otix
// Uses GOG's OAuth + embed.gog.com API for library scanning.
// Matching handled by host GameScanOrchestrator via /media/match/stream.

const https = require('https');
const http = require('http');
const path = require('path');
const querystring = require('querystring');

// ── GOG API Constants (public client credentials, same as official GOG client) ──

const CLIENT_ID = '46899977096215655';
const CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const AUTH_HOST = 'auth.gog.com';
const API_HOST = 'embed.gog.com';
const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

// ── HTTP Helpers ──────────────────────────────────────────────────────

function fetchJson(host, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = https;
    const reqOpts = {
      hostname: host, port: 443, path,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = mod.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, data: body, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 30000, () => { req.destroy(); reject(new Error('Request timed out')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function apiGet(host, path, token) {
  return fetchJson(host, path, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'User-Agent': 'Otix/0.1.0',
    },
  });
}

function apiPostForm(host, path, params) {
  const body = querystring.stringify(params);
  return fetchJson(host, path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'Otix/0.1.0',
    },
    body,
  });
}

// ── Token Management ──────────────────────────────────────────────────

async function getValidToken(ctx) {
  const accessToken = ctx.config.get('access_token');
  const expiresAt = ctx.config.get('token_expires_at');
  const refreshToken = ctx.config.get('refresh_token');
  if (!refreshToken) return null;
  if (accessToken && expiresAt && Date.now() < expiresAt) return accessToken;
  try {
    const res = await apiPostForm(AUTH_HOST, '/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (res.status === 200) {
      ctx.config.set('access_token', res.data.access_token);
      ctx.config.set('refresh_token', res.data.refresh_token);
      ctx.config.set('token_expires_at', Date.now() + (res.data.expires_in * 1000));
      ctx.config.set('user_id', res.data.user_id || '');
      return res.data.access_token;
    }
  } catch (e) {
    ctx.logger.error(`GOG token refresh failed: ${e.message}`);
  }
  return null;
}

// ── OAuth ─────────────────────────────────────────────────────────────

function getAuthUrl() {
  const params = querystring.stringify({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    layout: 'client2',
  });
  return `https://${AUTH_HOST}/auth?${params}`;
}

async function handleCallback(ctx, redirectUrl) {
  const code = new URL(redirectUrl).searchParams.get('code');
  if (!code) throw new Error('No authorization code in redirect URL');
  const res = await apiPostForm(AUTH_HOST, '/token', {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  if (res.status !== 200) throw new Error(`Token exchange failed: ${res.status}`);
  ctx.config.set('access_token', res.data.access_token);
  ctx.config.set('refresh_token', res.data.refresh_token);
  ctx.config.set('token_expires_at', Date.now() + (res.data.expires_in * 1000));
  ctx.config.set('user_id', res.data.user_id || '');
  try {
    const userData = await apiGet(API_HOST, '/userData.json', res.data.access_token);
    if (userData.status === 200 && userData.data?.username) {
      ctx.config.set('display_name', userData.data.username);
    }
  } catch {}
  return { success: true, displayName: ctx.config.get('display_name') || 'GOG User' };
}

function logout(ctx) {
  ctx.config.set('access_token', null);
  ctx.config.set('refresh_token', null);
  ctx.config.set('token_expires_at', null);
  ctx.config.set('user_id', null);
  ctx.config.set('display_name', null);
}

// ── API: Fetch owned games ────────────────────────────────────────────

async function fetchOwnedGames(token) {
  const res = await apiGet(API_HOST, '/account/games', token);
  const items = res.data?.games || [];
  const products = res.data?.products || {};
  return items.map(g => ({
    id: String(g.id),
    title: g.title || g.name || 'Unknown',
    developer: g.developer || (products[g.id]?.developer) || null,
    publisher: g.publisher || (products[g.id]?.publisher) || null,
    releaseYear: g.release_year || null,
    posterUrl: g.image || null,
    logoUrl: g.logo || products[g.id]?.logo || null,
    dlcOf: g.is_dlc ? String(g.parent_id || '') : null,
    categories: g.tags || [],
    installable: products[g.id]?.is_installable || false,
  }));
}

// ── Local install detection ───────────────────────────────────────────

const GOG_PATHS = [
  'C:\\GOG Games',
  'C:\\Program Files (x86)\\GOG Galaxy\\Games',
  'C:\\Program Files\\GOG Galaxy\\Games',
];

async function scanLocalInstalls(ctx) {
  const installed = new Map();
  for (const basePath of GOG_PATHS) {
    try {
      if (!(await ctx.filesystem.access(basePath))) continue;
      for (const entry of await ctx.filesystem.readdir(basePath)) {
        if (!entry.isDirectory) continue;
        const gameDir = path.join(basePath, entry.name);
        try {
          for (const file of await ctx.filesystem.readdir(gameDir)) {
            if (!file.isFile) continue;
            const n = file.name.toLowerCase();
            if (n.endsWith('.exe') && !n.includes('unins') && !n.includes('redist')) {
              if (!installed.has(entry.name)) {
                installed.set(entry.name, { exePath: path.join(gameDir, file.name), installDir: gameDir });
              }
              break;
            }
          }
        } catch {}
      }
    } catch {}
  }
  return installed;
}

// ── Data methods (flat keys for worker RPC dispatch) ──────────────────

const dataMethods = {
  scan: async (ctx) => {
    const token = await getValidToken(ctx);
    if (!token) {
      ctx.logger.warn('GOG scan: not authenticated, returning empty');
      return { games: [] };
    }

    ctx.host.emit('scan:progress', { currentDir: 'Fetching GOG library...', progress: 10 });
    const ownedGames = await fetchOwnedGames(token);

    ctx.host.emit('scan:progress', { currentDir: 'Scanning local installs...', progress: 50 });
    const localInstalls = await scanLocalInstalls(ctx);

    ctx.host.emit('scan:progress', { currentDir: 'Building game list...', progress: 80 });
    const games = ownedGames.map(g => {
      const local = localInstalls.get(g.title) || findLocalByTitle(localInstalls, g.title);
      const externalIds = [{ source: 'gog', id: g.id }];
      if (g.dlcOf) externalIds.push({ source: 'gog_parent', id: String(g.dlcOf) });
      return {
        id: g.id,
        title: g.title,
        platform: 'gog',
        externalIds,
        developer: g.developer,
        publisher: g.publisher,
        releaseYear: g.releaseYear,
        installPath: local?.installDir || null,
        exePath: local?.exePath || null,
        posterUrl: g.posterUrl,
        logoUrl: g.logoUrl,
        dlcOf: g.dlcOf ? String(g.dlcOf) : null,
        rawMetadata: { categories: g.categories, installable: g.installable },
      };
    });

    ctx.host.emit('scan:progress', { currentDir: 'Done', progress: 100 });
    ctx.logger.info(`GOG scan complete: ${games.length} games (${ownedGames.length} owned, ${localInstalls.size} local)`);
    return { games };
  },

  'scan.status': async (ctx) => ({ phase: 'idle' }),

  'auth.getLoginUrl': async (ctx) => ({ url: getAuthUrl() }),
  'auth.handleCallback': async (ctx, redirectUrl) => handleCallback(ctx, redirectUrl),
  'auth.logout': async (ctx) => { logout(ctx); return { success: true }; },
};

// ── Plugin exports ────────────────────────────────────────────────────

module.exports = {
  plugin: (ctx) => {
    ctx.logger.info('GOG Galaxy Scanner loaded');
  },

  data: dataMethods,

  status: async (ctx) => {
    const rt = await ctx.config.get('refresh_token');
    const display_name = await ctx.config.get('display_name');
    const last_scan_total = await ctx.config.get('_last_scan_total');
    const last_scan_at = await ctx.config.get('_last_scan_at');
    return {
      connected: !!rt,
      display_name: display_name || null,
      last_scan_total: last_scan_total || null,
      last_scan_at: last_scan_at || null,
    };
  },

  test: async (ctx, configDraft) => {
    const token = configDraft?.access_token || await ctx.config.get('access_token');
    if (!token) return { passed: false, failures: ['Not authenticated — log in with GOG first'] };
    const res = await apiGet(API_HOST, '/userData.json', token);
    if (res.status === 200) return { passed: true };
    return { passed: false, failures: [`API returned ${res.status}`] };
  },

  slotRender: async (ctx, location) => ({
    type: 'scan', platform: 'gog', label: 'GOG Galaxy',
    description: 'Scan your GOG Galaxy library',
    mediaTypes: ['games'],
    actions: { scan: 'scan', status: 'scan.status', login: 'auth.getLoginUrl', handleCallback: 'auth.handleCallback', logout: 'auth.logout' },
  }),
};

// ── Plugin exports ────────────────────────────────────────────────────

module.exports = {
  plugin: (ctx) => {
    ctx.logger.info('GOG Galaxy Scanner loaded');
  },

  data: dataMethods,

  status: async (ctx) => {
    const rt = await ctx.config.get('refresh_token');
    const display_name = await ctx.config.get('display_name');
    const last_scan_total = await ctx.config.get('_last_scan_total');
    const last_scan_at = await ctx.config.get('_last_scan_at');
    return {
      connected: !!rt,
      display_name: display_name || null,
      last_scan_total: last_scan_total || null,
      last_scan_at: last_scan_at || null,
    };
  },

  test: async (ctx, configDraft) => {
    const token = configDraft?.access_token || await ctx.config.get('access_token');
    if (!token) return { passed: false, failures: ['Not authenticated — log in with GOG first'] };
    const res = await apiGet(API_HOST, '/userData.json', token);
    if (res.status === 200) return { passed: true };
    return { passed: false, failures: [`API returned ${res.status}`] };
  },

  slotRender: async (ctx, location) => ({
    type: 'scan', platform: 'gog', label: 'GOG Galaxy',
    description: 'Scan your GOG Galaxy library',
    mediaTypes: ['games'],
    actions: { scan: 'scan', status: 'scan.status', login: 'auth.getLoginUrl', handleCallback: 'auth.handleCallback', logout: 'auth.logout' },
  }),
};

// ── Helpers ───────────────────────────────────────────────────────────

function findLocalByTitle(localInstalls, title) {
  if (!title) return null;
  const lower = title.toLowerCase();
  for (const [name, info] of localInstalls) {
    const nl = name.toLowerCase();
    if (nl === lower || nl.includes(lower) || lower.includes(nl)) return info;
  }
  return null;
}
