// Epic Games Scanner plugin for Otix
// Uses Epic's internal launcher API (launcherAppClient2) for OAuth + library scan.
// No backend Epic endpoints. Matching via /media/match/batch.

const https = require('https');
const http = require('http');

// ── Epic API Constants (from test-epic-api.js) ────────────────────────

const CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';
const BASIC_AUTH = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
const OAUTH_HOST = 'account-public-service-prod03.ol.epicgames.com';
const LIBRARY_HOST = 'library-service.live.use1a.on.epicgames.com';
const CATALOG_HOST = 'catalog-public-service-prod06.ol.epicgames.com';
const UA = 'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit';

// ── HTTP Helpers ──────────────────────────────────────────────────────

function fetchJson(host, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = true; // all Epic hosts are HTTPS
    const reqOpts = {
      hostname: host,
      port: 443,
      path,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const mod = isHttps ? https : http;
    const req = mod.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data: body, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 30000, () => { req.destroy(); reject(new Error('Request timed out')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function apiPost(host, path, body, token) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': UA,
  };
  headers['Authorization'] = token ? `bearer ${token}` : `Basic ${BASIC_AUTH}`;
  return fetchJson(host, path, { method: 'POST', headers, body });
}

function apiGet(host, path, token) {
  return fetchJson(host, path, {
    headers: {
      'Authorization': `bearer ${token}`,
      'User-Agent': UA,
      'Accept': 'application/json',
    },
  });
}

// ── OAuth ─────────────────────────────────────────────────────────────

function getAuthUrl() {
  const redirectUrl = encodeURIComponent(
    `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`
  );
  return `https://www.epicgames.com/id/login?redirectUrl=${redirectUrl}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    token_type: 'eg1',
  }).toString();
  return apiPost(OAUTH_HOST, '/account/api/oauth/token', body);
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    token_type: 'eg1',
  }).toString();
  return apiPost(OAUTH_HOST, '/account/api/oauth/token', body);
}

async function verifyToken(accessToken) {
  // Epic's launcher API doesn't have a dedicated verify endpoint.
  // Light check: try to fetch one page of library items.
  const res = await apiGet(
    OAUTH_HOST,
    '/account/api/oauth/verify',
    accessToken
  );
  return res;
}

// ── Library API ───────────────────────────────────────────────────────

async function fetchAllLibraryItems(token) {
  const allItems = [];
  let cursor = null;

  while (true) {
    let path = '/library/api/public/items?includeMetadata=true';
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;

    const { status, data } = await apiGet(LIBRARY_HOST, path, token);

    if (status !== 200) {
      throw new Error(`Library API returned ${status}: ${JSON.stringify(data).slice(0, 500)}`);
    }

    if (data.records) allItems.push(...data.records);

    const next = data.responseMetadata?.nextCursor;
    if (!next) break;
    cursor = next;
  }

  return allItems;
}

async function batchEnrichCatalog(token, items, ctx) {
  // Batch catalog enrichment — parallel per namespace, 15s total timeout
  const enriched = {};
  const byNamespace = {};
  for (const item of items) {
    const ns = item.namespace || 'fn';
    if (!byNamespace[ns]) byNamespace[ns] = new Set();
    byNamespace[ns].add(item.catalogItemId || item.offerId);
  }

  const fetchNamespace = async (namespace, ids) => {
    const idArray = [...ids].filter(Boolean);
    for (let i = 0; i < idArray.length; i += 50) {
      const batch = idArray.slice(i, i + 50);
      if (!batch.length) continue;
      try {
        const path = `/catalog/api/shared/namespace/${namespace}/bulk/items?id=${batch.join('&id=')}&country=US&locale=en-US`;
        const { status, data } = await apiGet(CATALOG_HOST, path, token);
        if (status === 200 && data) {
          for (const [id, catItem] of Object.entries(data)) {
            const sellerId = catItem.seller?.id || null;
            const sellerName = catItem.seller?.name || null;
            enriched[id] = {
              title: catItem.title || null,
              developer: catItem.developerDisplayName || sellerName || null,
              developerId: sellerId,  // Epic account ID of the developer/company
              publisher: catItem.publisherDisplayName || sellerName || null,
              keyImages: catItem.keyImages || [],
              description: catItem.description || null,
              categories: catItem.categories || [],
              sellerName: sellerName,
              // External reference for the developer company
              external_ids: sellerId ? [{ source: 'epic', id: sellerId, entity_type: 'company', name: sellerName }] : [],
            };
          }
        }
      } catch (err) {
        ctx.logger.warn('Catalog enrichment failed for ' + namespace + ': ' + err.message);
      }
    }
  };

  // Run all namespaces in parallel with 15s timeout
  const tasks = Object.entries(byNamespace).map(([ns, ids]) => fetchNamespace(ns, ids));
  await Promise.race([
    Promise.all(tasks),
    new Promise((resolve) => setTimeout(resolve, 15000)),
  ]);

  return enriched;
}

async function fetchCatalogItem(token, namespace, catalogItemId) {
  const path = `/catalog/api/shared/namespace/${namespace}/bulk/items?id=${catalogItemId}&country=US&locale=en-US`;
  const { status, data } = await apiGet(CATALOG_HOST, path, token);
  if (status !== 200) return null;
  return data[catalogItemId] || null;
}

// ── Local Manifest Scan ──────────────────────────────────────────────

async function scanLocalInstalls(ctx) {
  const fs = require('fs');
  const path = require('path');
  const installedMap = {};

  const manifestDir = path.join(
    process.env.PROGRAMDATA || 'C:\\ProgramData',
    'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'
  );

  try {
    if (!fs.existsSync(manifestDir)) {
      ctx.logger.info('Epic manifests directory not found: ' + manifestDir);
      return installedMap;
    }

    const files = fs.readdirSync(manifestDir).filter((f) => f.endsWith('.item'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(manifestDir, file), 'utf-8');
        const m = JSON.parse(raw);
        if (m.AppName) {
          const installPath = m.InstallLocation || null;
          // Derive save game paths from common patterns
          const savePaths = [];
          if (installPath) {
            // Common Epic save locations relative to install
            const savedDir = path.join(installPath, 'Saved');
            if (fs.existsSync(savedDir)) savePaths.push(savedDir);

            // %LOCALAPPDATA%/<GameName>/Saved/SaveGames
            const localAppData = process.env.LOCALAPPDATA;
            if (localAppData) {
              const localSave = path.join(localAppData, m.AppName, 'Saved', 'SaveGames');
              if (fs.existsSync(localSave)) savePaths.push(localSave);
            }

            // Documents/My Games/<GameName>
            const documents = path.join(process.env.USERPROFILE || '', 'Documents', 'My Games', m.AppName);
            if (fs.existsSync(documents)) savePaths.push(documents);

            // Saved Games/<GameName>
            const savedGames = path.join(process.env.USERPROFILE || '', 'Saved Games', m.AppName);
            if (fs.existsSync(savedGames)) savePaths.push(savedGames);
          }

          installedMap[m.AppName] = {
            install_path: installPath,
            install_size: m.InstallSize || null,
            version: m.AppVersionString || null,
            launch_executable: m.LaunchExecutable || null,
            manifest_location: m.ManifestLocation || null,
            save_paths: savePaths.length > 0 ? savePaths : null,
          };
        }
      } catch (err) {
        ctx.logger.warn('Failed to parse manifest ' + file + ': ' + err.message);
      }
    }
  } catch (err) {
    ctx.logger.warn('Local scan error: ' + err.message);
  }

  return installedMap;
}

// ── Token Management (promise-lock, no race conditions) ───────────────

let _currentToken = null;
let _tokenPromise = null;

function _getRt(ctx) {
  return ctx.config.get('refresh_token');
}

async function _storeAuth(ctx, displayName, accountId, refreshToken) {
  await ctx.config.set('display_name', displayName);
  await ctx.config.set('account_id', accountId);
  await ctx.config.set('refresh_token', refreshToken);
}

function _clearAuth(ctx) {
  _currentToken = null;
  _tokenPromise = null;
  ctx.config.set('display_name', '');
  ctx.config.set('account_id', '');
  ctx.config.set('refresh_token', '');
}

async function _ensureToken(ctx) {
  if (_currentToken) {
    try {
      const v = await verifyToken(_currentToken);
      if (v.status === 200) return _currentToken;
    } catch (err) {
      ctx.logger.warn('Token verification failed, refreshing: ' + err.message);
    }
    _currentToken = null;
  }

  if (_tokenPromise) return _tokenPromise;

  _tokenPromise = (async () => {
    const rt = await _getRt(ctx);
    if (!rt) return null;

    const r = await refreshAccessToken(rt);
    if (r.status !== 200) {
      _clearAuth(ctx);
      ctx.logger.error('Token refresh failed: ' + JSON.stringify(r.data).slice(0, 300));
      return null;
    }

    _currentToken = r.data.access_token;
    await _storeAuth(
      ctx,
      r.data.display_name || r.data.account_id || '',
      r.data.account_id || '',
      r.data.refresh_token || rt
    );
    return _currentToken;
  })();

  try {
    return await _tokenPromise;
  } finally {
    _tokenPromise = null;
  }
}

// ── Scan Progress ─────────────────────────────────────────────────────

let _scanProgress = {
  phase: 'idle',
  current: 0,
  total: 0,
  startedAt: null,
  error: null,
};

function _setProgress(ctx, update) {
  Object.assign(_scanProgress, update);
  ctx.config.set('_scan_progress', JSON.stringify(_scanProgress)).catch(() => {});
}

// ── Core Scan ─────────────────────────────────────────────────────────

async function performScan(ctx) {
  _setProgress(ctx, { phase: 'library', current: 0, total: 0, startedAt: Date.now(), error: null });
  ctx.logger.info('Starting Epic Games library scan...');

  const token = await _ensureToken(ctx);
  if (!token) {
    _setProgress(ctx, { phase: 'error', error: 'Not authenticated' });
    return { success: false, error: 'not_authenticated', games: [] };
  }

  const accountId = await ctx.config.get('account_id');
  if (!accountId) {
    _setProgress(ctx, { phase: 'error', error: 'No account ID' });
    return { success: false, error: 'no_account_id', games: [] };
  }

  // Phase 1: Fetch library
  let libraryItems;
  try {
    libraryItems = await fetchAllLibraryItems(token);
  } catch (err) {
    ctx.logger.error('Library fetch failed: ' + err.message);
    _setProgress(ctx, { phase: 'error', error: err.message });
    return { success: false, error: err.message, games: [] };
  }

  _setProgress(ctx, { phase: 'enriching', current: 0, total: libraryItems.length });
  ctx.logger.info('Library fetched: ' + libraryItems.length + ' items');

  // Phase 2: Local manifest scan
  const localInstalls = await scanLocalInstalls(ctx);

  _setProgress(ctx, { phase: 'merging', current: 0, total: libraryItems.length });

  // Phase 3: Merge data
  const SKIP_PREFIXES = ['UE_', 'QuixelBridge_', 'MetaHumanSample_', 'Lyra_', 'FabPlugin_'];
  const games = [];
  let skipped = 0;
  for (let i = 0; i < libraryItems.length; i++) {
    const item = libraryItems[i];
    const appName = item.appName || item.sandboxId || item.id;

    // Skip Unreal Engine assets, Quixel, MetaHuman samples
    if (SKIP_PREFIXES.some((p) => appName.startsWith(p))) {
      skipped++;
      continue;
    }

    const local = localInstalls[appName] || {};

    const title = item.sandboxName || item.appTitle || item.title || appName;

    games.push({
      appName,
      namespace: item.namespace || null,
      catalogItemId: item.catalogItemId || null,
      title,
      developer: item.developer || null,
      developerId: null,  // populated by catalog enrichment
      isInstalled: !!local.install_path,
      installPath: local.install_path || null,
      installSize: local.install_size || null,
      version: local.version || null,
      launchExe: local.launch_executable || null,
      manifestLocation: local.manifest_location || null,
      savePaths: local.save_paths || null,
      // Epic posterUrl set during enrichment below — always available
      // as fallback until Otix/SGDB poster replaces it after matching
      posterUrl: null,
      logoUrl: null,
    });

    if ((i + 1) % 50 === 0 || i === libraryItems.length - 1) {
      _setProgress(ctx, { phase: 'merging', current: i + 1, total: libraryItems.length });
    }
  }

  // Phase 4: Enrich with catalog data (posters, real titles) — 15s timeout
  _setProgress(ctx, { phase: 'enriching', current: 0, total: games.length });
  try {
    ctx.logger.info('Enriching catalog (15s timeout)...');
    const enriched = await batchEnrichCatalog(token, libraryItems, ctx);
    const enrichedCount = Object.keys(enriched).length;
    _setProgress(ctx, { phase: 'enriching', current: enrichedCount, total: games.length });
    ctx.logger.info('Catalog enriched: ' + enrichedCount + ' items');

    // Merge enrichment into games
    for (const g of games) {
      const catId = g.catalogItemId;
      if (catId && enriched[catId]) {
        const e = enriched[catId];
        if (e.title) g.title = e.title;
        if (e.developer) g.developer = e.developer;
        if (e.publisher) g.publisher = e.publisher;
        if (e.developerId) g.developerId = e.developerId;
        if (e.sellerName) g.sellerName = e.sellerName;
        if (e.external_ids?.length) g.developerExternalIds = e.external_ids;
        const posterUrl = e.keyImages?.find((img) =>
          img.type === 'DieselStoreFrontWide' || img.type === 'Thumbnail'
        )?.url;
        if (posterUrl) g.posterUrl = posterUrl;
        const logoUrl = e.keyImages?.find((img) =>
          img.type === 'DieselGameBoxLogo'
        )?.url;
        if (logoUrl) g.logoUrl = logoUrl;
      }
    }
  } catch (err) {
    ctx.logger.warn('Enrichment failed: ' + err.message);
  }

  _setProgress(ctx, { phase: 'done', current: games.length, total: games.length });
  ctx.logger.info('Scan complete: ' + games.length + ' games, ' + games.filter((g) => g.isInstalled).length + ' installed' + (skipped > 0 ? ', ' + skipped + ' skipped (UE/Quixel/MetaHuman)' : ''));

  // Persist scan summary so React doesn't re-scan on every page mount
  const scanSummary = {
    last_scan_total: games.length,
    last_scan_installed: games.filter((g) => g.isInstalled).length,
    last_scan_at: Date.now(),
  };
  await ctx.config.set('_last_scan', JSON.stringify(scanSummary));

  return {
    success: true,
    total: games.length,
    installed: games.filter((g) => g.isInstalled).length,
    games,
  };
}

// ── Plugin Entry ──────────────────────────────────────────────────────

function epicGamesPlugin(ctx) {
  ctx.logger.info('Epic Games Scanner loaded');

  // Auto-scan on startup if configured
  ctx.config.get('auto_sync').then((autoSync) => {
    if (autoSync !== false) { // default true
      ctx.config.get('refresh_token').then((rt) => {
        if (rt) {
          ctx.logger.info('Auto-sync triggered on startup');
          performScan(ctx).catch((err) =>
            ctx.logger.error('Auto-scan failed: ' + err.message)
          );
        }
      });
    }
  });

  return () => {
    ctx.logger.info('Epic Games Scanner unloaded');
  };
}

// ── Data Methods ──────────────────────────────────────────────────────

const dataMethods = {
  'auth.getLoginUrl': async () => {
    return { url: getAuthUrl() };
  },

  'auth.handleCallback': async (ctx, code) => {
    if (!code) return { success: false, error: 'No authorization code provided' };

    ctx.logger.info('Exchanging authorization code...');
    try {
      const res = await exchangeCode(code);
      if (res.status !== 200 || !res.data.access_token) {
        ctx.logger.error('Code exchange failed: ' + JSON.stringify(res.data).slice(0, 300));
        return { success: false, error: 'Token exchange failed' };
      }

      const d = res.data;
      _currentToken = d.access_token;
      await _storeAuth(ctx, d.display_name || d.account_id, d.account_id, d.refresh_token);

      ctx.logger.info('Authenticated as ' + (d.display_name || d.account_id));
      ctx.notifications.send({ title: 'Epic Games', body: 'Connected as ' + (d.display_name || d.account_id) });

      // Auto-scan after login
      const autoSync = await ctx.config.get('auto_sync');
      if (autoSync !== false) { // default true
        ctx.logger.info('Auto-scan triggered after login');
        const scanResult = await performScan(ctx);
        return {
          success: true,
          account_id: d.account_id,
          display_name: d.display_name || d.account_id,
          scan: scanResult,
        };
      }

      return { success: true, account_id: d.account_id, display_name: d.display_name || d.account_id };
    } catch (err) {
      ctx.logger.error('handleCallback error: ' + err.message);
      return { success: false, error: err.message };
    }
  },

  'auth.logout': async (ctx) => {
    _clearAuth(ctx);
    ctx.logger.info('Logged out');
    return { success: true };
  },

  'scan': async (ctx) => {
    return performScan(ctx);
  },

  'scan.status': async () => {
    return { ..._scanProgress };
  },

  'match.batch': async (ctx, games) => {
    if (!games || !games.length) return { success: false, error: 'No games provided', matches: [] };

    // Build a lookup map of appName → scan game for poster fallback
    const scanGameByAppName = {};
    for (const g of games) {
      const key = g.appName || g.catalogItemId || '';
      if (key) scanGameByAppName[key] = g;
    }

    const batchGames = games.map((g) => ({
      query_id: 'epic:' + (g.appName || g.catalogItemId || ''),
      title: g.title || g.appName || '',
      developer: g.developer || g.publisher || null,
      publisher: g.publisher || g.developer || null,
      external_ids: [{ source: 'epic', id: g.appName || g.catalogItemId || '' }],
      media_type: 'game',
    }));

    try {
      const result = await ctx.api.post('/media/match/batch', { games: batchGames });
      const matches = (result.matches || result || []).map((m, i) => {
        const scanGame = games[i] || {};
        // Inject Epic poster as fallback so UI shows image even for
        // needs_import candidates where IGDB cover might be missing
        if (m.candidates) {
          for (const c of m.candidates) {
            if (!c.poster_url && scanGame.posterUrl) {
              c.poster_url = scanGame.posterUrl;
            }
          }
        }
        if (m.auto_match && !m.auto_match.poster_url && scanGame.posterUrl) {
          m.auto_match.poster_url = scanGame.posterUrl;
        }
        return {
          ...m,
          _epic_poster_url: scanGame.posterUrl || null,
          _epic_logo_url: scanGame.logoUrl || null,
        };
      });
      return { success: true, matches };
    } catch (err) {
      ctx.logger.error('match.batch failed: ' + err.message);
      return { success: false, error: err.message, matches: [] };
    }
  },

  'match.confirm': async (ctx, params) => {
    if (!params || !params.query_id) return { success: false, error: 'query_id required' };

    try {
      const result = await ctx.api.post('/media/match/confirm', {
        query_id: params.query_id,
        media_item_id: params.media_item_id || null,
        igdb_id: params.igdb_id || null,
        rejected: params.rejected || false,
        rejected_permanently: params.rejected_permanently || false,
      });
      return { success: result.success, media_item_id: result.media_item_id, error: result.error };
    } catch (err) {
      ctx.logger.error('match.confirm failed: ' + err.message);
      return { success: false, error: err.message };
    }
  },

  'match.unlink': async (ctx, queryId) => {
    if (!queryId) return { success: false, error: 'query_id required' };

    try {
      const result = await ctx.api.get('/media/match/unlink?query_id=' + encodeURIComponent(queryId));
      return { success: result.success, error: result.error };
    } catch (err) {
      ctx.logger.error('match.unlink failed: ' + err.message);
      return { success: false, error: err.message };
    }
  },
};

// ── Top-level exports (Worker RPC dispatch) ───────────────────────────

module.exports = {
  plugin: epicGamesPlugin,
  data: dataMethods,

  status: async (ctx) => {
    try {
      const rt = await _getRt(ctx);
      if (!rt) return { connected: false, account_id: null, display_name: null, last_scan_total: 0, last_scan_at: null };

      const token = await _ensureToken(ctx);
      if (!token) return { connected: false, account_id: null, display_name: null, last_scan_total: 0, last_scan_at: null };

      const accountId = await ctx.config.get('account_id');
      const displayName = await ctx.config.get('display_name');

      // Read persisted scan summary to avoid redundant re-scans on page mount
      let lastScanTotal = 0;
      let lastScanAt = null;
      try {
        const raw = await ctx.config.get('_last_scan');
        if (raw) {
          const summary = typeof raw === 'string' ? JSON.parse(raw) : raw;
          lastScanTotal = summary.last_scan_total || 0;
          lastScanAt = summary.last_scan_at || null;
        }
      } catch { /* ignore parse errors */ }

      return {
        connected: true,
        account_id: accountId,
        display_name: displayName,
        last_scan_total: lastScanTotal,
        last_scan_at: lastScanAt,
      };
    } catch {
      return { connected: false, account_id: null, display_name: null, last_scan_total: 0, last_scan_at: null };
    }
  },

  test: async (ctx) => {
    const rt = await _getRt(ctx);
    if (!rt) return { success: false, message: 'Not connected. Sign in first.' };

    try {
      const token = await _ensureToken(ctx);
      if (!token) return { success: false, message: 'Auth expired. Sign in again.' };
      return { success: true, message: 'Connected and authenticated' };
    } catch (err) {
      return { success: false, message: 'Connection check failed: ' + err.message };
    }
  },

  // Re-export all data methods at top level
  'auth.getLoginUrl': dataMethods['auth.getLoginUrl'],
  'auth.handleCallback': dataMethods['auth.handleCallback'],
  'auth.logout': dataMethods['auth.logout'],
  'scan': dataMethods['scan'],
  'scan.status': dataMethods['scan.status'],
  'match.batch': dataMethods['match.batch'],
  'match.confirm': dataMethods['match.confirm'],
  'match.unlink': dataMethods['match.unlink'],

  slotRender: async (ctx, slotName) => {
    if (slotName === 'matching:scan') {
      return {
        type: 'scan',
        platform: 'epic',
        label: 'Epic Games',
        description: 'Scan and match your Epic Games library',
        actions: {
          status: 'status',
          scan: 'scan',
          match: 'match.batch',
          confirm: 'match.confirm',
        },
      };
    }
    // library:scan
    return {
      type: 'scan',
      platform: 'epic',
      label: 'Epic Games',
      description: 'Scan your Epic Games library and match against Otix media',
      actions: {
        status: 'status',
        login: 'auth.getLoginUrl',
        handleCallback: 'auth.handleCallback',
        logout: 'auth.logout',
        scan: 'scan',
        match: 'match.batch',
        confirm: 'match.confirm',
      },
    };
  },
};
