// extensions/otix-plugins/plugins/local-files/main.js
// Local game directory scanner plugin — ported from desktop/game/scanner.ts

const path = require('path');

// ── Pure helpers ──────────────────────────────────────────────────────

function parseAcf(content) {
  const result = {};
  const matches = content.matchAll(/"([^"]+)"\s+"([^"]+)"/g);
  for (const match of matches) result[match[1]] = match[2];
  return result;
}

function generateId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return 'pc_' + Math.abs(hash).toString(36);
}

function cleanGameTitle(filename) {
  let name = filename.replace(/\.iso$/i, '');
  name = name.replace(/[\._\-]/g, ' ');
  const tags = [
    /\[repack\]/gi, /\brepack\b/gi, /\belamigos\b/gi, /\bfitgirl\b/gi, /\bdodi\b/gi,
    /\bcodex\b/gi, /\bflt\b/gi, /\bplaza\b/gi, /\bskidrow\b/gi, /\brune\b/gi, /\btenoke\b/gi,
    /\bgoldberg\b/gi, /\brazor1911\b/gi, /\bfairlight\b/gi, /\bhoodlum\b/gi,
    /\bmulti\d+\b/gi, /\bvoices\d*\b/gi, /\bv\d+(\.\d+)*\b/gi, /\bbuild\s*\d+\b/gi, /\bupdate\s*\d*\b/gi,
    /\bhbg\b/gi, /\bdlc\b/gi, /\bgog\b/gi, /\bcrack\b/gi
  ];
  for (const tag of tags) name = name.replace(tag, '');
  name = name.replace(/\[\s*\]/g, '').replace(/\(\s*\)/g, '').replace(/\{\s*\}/g, '');
  name = name.replace(/[\s\-\+\:\,]+$/, '');
  return name.replace(/\s+/g, ' ').trim();
}

const IGNORED_DIRS = new Set([
  'node_modules', 'bower_components', '.git', '.github', '.svn', '.hg',
  'system32', 'syswow64', 'windows', 'microsoft.net', 'appdata',
  'obj', 'bin', '__pycache__', '.venv', 'venv', 'env', 'windowsapps'
]);

// ── Launcher detection ─────────────────────────────────────────────────

function detectLauncher(installDir, exePath) {
  const d = (installDir || exePath || '').toLowerCase().replace(/\\/g, '/');
  // Xbox app (Microsoft Store / Game Pass)
  if (d.includes('/xboxgames/') || d.includes('/windowsapps/') || d.includes('/microsoft games/')) return 'xbox';
  // Epic Games
  if (d.includes('/epic games/') || d.includes('/epicgames/')) return 'epic';
  // GOG Galaxy
  if (d.includes('/gog games/') || d.includes('/gog galaxy/') || d.includes('/galaxy games/')) return 'gog';
  // Battle.net
  if (d.includes('/battle.net/') || d.includes('/blizzard/')) return 'battlenet';
  // Ubisoft Connect
  if (d.includes('/ubisoft/') || d.includes('/ubisoft connect/') || d.includes('/ubisoft game launcher/')) return 'ubisoft';
  // EA App / Origin
  if (d.includes('/ea games/') || d.includes('/origin games/') || d.includes('/ea desktop/')) return 'ea';
  // Riot Games
  if (d.includes('/riot games/')) return 'riot';
  // Itch.io
  if (d.includes('/itch.io/') || d.includes('/itchio/')) return 'itch';
  return 'pc';
}

function detectXboxFromPath(dir, exePath) {
  const d = (dir || exePath || '').toLowerCase().replace(/\\/g, '/');
  return d.includes('/xboxgames/') || d.includes('/windowsapps/');
}

// ── Non-game detection ─────────────────────────────────────────────────
// Skip tools, demos, betas, DLC stubs that shouldn't be matched

const NON_GAME_PATTERNS = [
  /(\b|_)demo(\b|_)/i,           // Factory Planner Demo
  /(\b|_)benchmark(\b|_)/i,      // benchmarks
  /(\b|_)server(\b|_)/i,         // dedicated servers
  /(\b|_)launcher(\b|_)/i,       // game launchers (not games)
  /(\b|_)beta(\b|_)/i,           // KillingFloor2Beta
  /\bstub\b/i,                   // DLC stubs
  /\btracker\b/i,                // launch tracker
  /\btelemetry\b/i,              // telemetry tools
  /\bcrash\s*reporter\b/i,
  /\berror\s*reporter\b/i,
  /\bsteamworks\b/i,
  /\bredist\b/i,
]

const KNOWN_NON_GAMES = new Set([
  'steelseries', 'razer', 'logitech', 'corsair', 'nvidia',
  'amd', 'intel', 'msi', 'asus', 'gigabyte', 'evga',
  'discord', 'teamspeak', 'ventrilo', 'mumble',
  'obs', 'streamlabs', 'twitch', 'xsplit',
  'winrar', '7zip', 'vlc', 'notepad', 'chrome', 'firefox',
  'microsoft', 'windows', 'office', 'adobe',
  'java', 'python', '虚幻引擎', 'unreal engine',
  'epicgameslauncher', 'epic games launcher',
  'steam client', 'ubisoft connect', 'ea app', 'ea desktop',
  'gog galaxy', 'battle.net', 'battlenet',
  'xbox game bar', 'xbox console companion',
  'game bar', 'widgets', 'calculator', 'settings',
])

function isNonGame(title, exePath, installDir) {
  const t = (title || '').toLowerCase().trim()
  const exe = path.basename(exePath || '', '.exe').toLowerCase()
  const d = (installDir || '').toLowerCase().replace(/\\/g, '/')

  // Check known non-game names
  for (const nonGame of KNOWN_NON_GAMES) {
    if (t === nonGame || exe === nonGame || d.includes('/' + nonGame + '/')) return true
  }

  // Check title patterns
  for (const pattern of NON_GAME_PATTERNS) {
    if (pattern.test(t)) return true
  }

  // Executable name heuristics
  const EXE_BLOCKLIST = [
    'unins', 'setup', 'helper', 'crash', 'redist', 'config',
    'install', 'update', 'patch', 'register', 'activate',
    'updater', 'launcher', 'notifier', 'tray', 'service',
    'gamelaunchhelper', 'gamingservices', 'xboxgamebar',
  ]
  if (EXE_BLOCKLIST.some(s => exe.includes(s))) return true
  if (exe.startsWith('vc_') || exe.startsWith('dx')) return true

  return false
}

async function pickBestExe(ctx, exes, installDirName) {
  if (exes.length === 0) return null;
  if (exes.length === 1) return exes[0];
  const cleanInstallDir = installDirName.toLowerCase().replace(/[^a-z0-9]/g, '');
  let bestExe = null, bestScore = -1, bestSize = 0;
  for (const exe of exes) {
    const exeName = path.basename(exe, '.exe').toLowerCase();
    if (['crash','unins','setup','redist','config','tool','cef','helper','register','patch'].some(s => exeName.includes(s))) continue;
    let score = 0;
    if (exeName.includes('shipping')) score += 80;
    const fnLower = installDirName.toLowerCase();
    const folderIdx = exe.toLowerCase().indexOf(fnLower);
    if (folderIdx >= 0 && (exe.toLowerCase().substring(folderIdx + fnLower.length).match(/[\\/]/g) || []).length > 1) score += 30;
    if (exeName === cleanInstallDir || exeName === installDirName.toLowerCase()) score += 100;
    else if (exeName.includes(cleanInstallDir) || cleanInstallDir.includes(exeName)) score += 50;
    let fileSize = 0;
    try { const s = await ctx.filesystem.stat(exe); fileSize = s.size; score += Math.min(30, Math.floor(s.size / (1024 * 1024))); } catch {}
    if (score > bestScore) { bestScore = score; bestExe = exe; bestSize = fileSize; }
  }
  // Return null for stubs — executables under 2MB are likely launchers, not real games
  if (bestExe && bestSize > 0 && bestSize < 2 * 1024 * 1024) return null;
  return bestExe;
}

// ── Filesystem helpers ────────────────────────────────────────────────

async function scanExecutables(ctx, dir, maxDepth) {
  const exes = [];
  async function traverse(currentDir, depth) {
    if (depth > maxDepth) return;
    try {
      const entries = await ctx.filesystem.readdir(currentDir);
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory) {
          const nl = entry.name.toLowerCase();
          if (nl.startsWith('$') || IGNORED_DIRS.has(nl)) continue;
          await traverse(fullPath, depth + 1);
        } else if (entry.isFile || entry.isSymbolicLink) {
          if (entry.name.toLowerCase().endsWith('.exe')) exes.push(fullPath);
        }
      }
    } catch {}
  }
  await traverse(dir, 1);
  return exes;
}

async function scanIsos(ctx, dir, maxDepth) {
  const isos = [];
  async function traverse(currentDir, depth) {
    if (depth > maxDepth) return;
    try {
      const entries = await ctx.filesystem.readdir(currentDir);
      for (const entry of entries) {
        if (entry.isDirectory) {
          const nl = entry.name.toLowerCase();
          if (nl.startsWith('$') || IGNORED_DIRS.has(nl)) continue;
          await traverse(path.join(currentDir, entry.name), depth + 1);
        } else if (entry.isFile || entry.isSymbolicLink) {
          if (entry.name.toLowerCase().endsWith('.iso')) isos.push(path.join(currentDir, entry.name));
        }
      }
    } catch {}
  }
  await traverse(dir, 1);
  return isos;
}

async function findUpdateFilesForIso(ctx, isoPath) {
  const updates = [], visited = new Set();
  async function scanFolder(folderPath, depth) {
    if (depth > 2) return;
    try {
      const entries = await ctx.filesystem.readdir(folderPath);
      for (const entry of entries) {
        const fullPath = path.join(folderPath, entry.name);
        if (entry.isDirectory) {
          const nl = entry.name.toLowerCase();
          if (nl.startsWith('$') || IGNORED_DIRS.has(nl)) continue;
          await scanFolder(fullPath, depth + 1);
        } else if (entry.isFile || entry.isSymbolicLink) {
          const nl = entry.name.toLowerCase();
          if (nl.endsWith('.exe') && (nl.includes('update') || nl.includes('patch')) &&
              !nl.includes('setup') && !nl.includes('uninst') && !nl.includes('crash') && !nl.includes('helper') && !visited.has(fullPath)) {
            visited.add(fullPath);
            updates.push({ name: entry.name, path: fullPath });
          }
        }
      }
    } catch {}
  }
  const isoDir = path.dirname(isoPath), isoParentDir = path.dirname(isoDir);
  const foldersToScan = new Set();
  for (const base of [isoParentDir, path.dirname(isoParentDir)]) {
    try { for (const e of await ctx.filesystem.readdir(base)) {
      if (e.isDirectory) { const n = e.name.toLowerCase(); if (n.includes('update') || n.includes('patch')) foldersToScan.add(path.join(base, e.name)); }
    } } catch {}
  }
  foldersToScan.add(isoDir);
  try { for (const e of await ctx.filesystem.readdir(isoDir)) {
    if (e.isDirectory) { const n = e.name.toLowerCase(); if (n.includes('update') || n.includes('patch')) foldersToScan.add(path.join(isoDir, e.name)); }
  } } catch {}
  for (const f of foldersToScan) await scanFolder(f, 1);
  updates.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return updates;
}

function getGameFolder(exePath, searchRoot) {
  let current = path.dirname(exePath);
  const rootLower = searchRoot.toLowerCase();
  const SKIP = new Set(['bin','x64','win64','x86','win32','release','build','dist','engine','win-unpacked','launcher','subsystem']);
  while (current.toLowerCase() !== rootLower) {
    const parent = path.dirname(current);
    const fn = path.basename(current).toLowerCase();
    if (SKIP.has(fn)) { current = parent; } else break;
  }
  return current;
}

function deduplicate(games) {
  const unique = [], seenIds = new Set(), seenExes = new Set(), seenInstallDirs = new Set();
  const norm = p => { try { return path.resolve(p).toLowerCase(); } catch { return p.toLowerCase(); } };
  for (const g of games) {
    const id = g.id.toLowerCase();
    const exe = g.exePath.startsWith('steam://') ? g.exePath.toLowerCase() : norm(g.exePath);
    const le = g.localExePath ? norm(g.localExePath) : null;
    const idir = norm(g.installDir);
    if (seenIds.has(id) || seenExes.has(exe) || (le && seenExes.has(le)) || (g.platform !== 'iso' && seenInstallDirs.has(idir))) continue;
    seenIds.add(id); seenExes.add(exe); if (le) seenExes.add(le);
    if (g.platform !== 'iso') seenInstallDirs.add(idir);
    unique.push(g);
  }
  return unique;
}

// ── Module-level scan progress ────────────────────────────────────────
var _scanProgress = { phase: 'idle', current: 0, total: 0, currentDir: '' };

// ── Plugin exports ────────────────────────────────────────────────────

module.exports = {
  plugin: (ctx) => {
    ctx.logger.info('Local Files Scanner loaded');
    // Auto-scan on startup (delayed — wait for inter-plugin RPC to be ready)
    setTimeout(() => {
      ctx.call('local-files', 'scan').catch(() => {});
    }, 3000);
  },

  data: {
    scan: async (ctx) => {
      const rawScan = await ctx.config.get('scanDirectories');
      const rawIso = await ctx.config.get('isoDirectories');
      const scanDirs = Array.isArray(rawScan) ? rawScan : [];
      const isoDirs = Array.isArray(rawIso) ? rawIso : [];
      const allGames = [];
      let idx = 0;
      const total = scanDirs.length + isoDirs.length;
      _scanProgress = { phase: 'scanning', current: 0, total: total || 1 };
      const emit = (dir) => {
        _scanProgress.current = idx;
        _scanProgress.phase = 'scanning';
        _scanProgress.currentDir = dir;
        ctx.host.emit('scan:progress', { currentDir: dir, progress: total > 0 ? Math.round((idx / total) * 100) : 100 });
      };

      for (const dir of scanDirs) {
        emit(dir);
        try {
          if (!(await ctx.filesystem.access(dir))) { idx++; continue; }
          const filesInDir = await ctx.filesystem.readdir(dir);
          const hasSA = filesInDir.some(e => e.name === 'steamapps' && e.isDirectory);
          const isSA = dir.toLowerCase().endsWith('steamapps');
          const saPath = hasSA ? path.join(dir, 'steamapps') : (isSA ? dir : null);

          if (saPath) {
            for (const file of await ctx.filesystem.readdir(saPath)) {
              if (!file.name.startsWith('appmanifest_') || !file.name.endsWith('.acf')) continue;
              try {
                const content = await ctx.filesystem.readFile(path.join(saPath, file.name), 'utf-8');
                const data = parseAcf(content);
                const { appid, name, installdir } = data;
                if (!appid || !name || !installdir) continue;
                const commonDir = path.join(saPath, 'common', installdir);
                let localExePath, localIconUrl;
                try { const exe = await pickBestExe(ctx, await scanExecutables(ctx, commonDir, 3), installdir); if (exe) localExePath = exe; } catch {}
                if (localExePath) localIconUrl = (await ctx.app.getFileIcon(localExePath)) || undefined;
                allGames.push({ id: appid, title: name, exePath: `steam://rungameid/${appid}`, localExePath, installDir: commonDir, platform: 'steam', localIconUrl });
              } catch {}
            }
          } else {
            const selfExes = await scanExecutables(ctx, dir, 2);
            const hasSelf = selfExes.some(exe => {
              const n = path.basename(exe).toLowerCase();
              if (['unins','setup','helper','crash'].some(s => n.includes(s))) return false;
              return path.resolve(getGameFolder(exe, dir)).toLowerCase() === path.resolve(dir).toLowerCase();
            });
            if (hasSelf) {
              const best = await pickBestExe(ctx, selfExes, path.basename(dir));
              if (best) {
                const ct = cleanGameTitle(path.basename(dir));
                if (!isNonGame(ct, best, dir)) allGames.push({ id: generateId(best), title: ct, exePath: best, installDir: dir, platform: detectLauncher(dir, best), localIconUrl: (await ctx.app.getFileIcon(best)) || undefined });
              }
            } else {
              for (const entry of await ctx.filesystem.readdir(dir)) {
                if (!entry.isDirectory) continue;
                const n = entry.name.toLowerCase();
                if (n.startsWith('$') || IGNORED_DIRS.has(n)) continue;
                const gf = path.join(dir, entry.name);
                const subExes = await scanExecutables(ctx, gf, 3);
                if (subExes.length > 0) {
                  const best = await pickBestExe(ctx, subExes, entry.name);
                  if (best) {
                    const ct = cleanGameTitle(entry.name);
                    if (!isNonGame(ct, best, gf)) allGames.push({ id: generateId(best), title: ct, exePath: best, installDir: gf, platform: detectLauncher(gf, best), localIconUrl: (await ctx.app.getFileIcon(best)) || undefined });
                  }
                }
              }
            }
          }
        } catch (e) { ctx.logger.error(`Error scanning ${dir}: ${e?.message ?? e}`); }
        idx++;
      }

      for (const dir of isoDirs) {
        emit(dir);
        try {
          if (!(await ctx.filesystem.access(dir))) { idx++; continue; }
          for (const iso of await scanIsos(ctx, dir, 3)) {
            const fn = path.basename(iso, '.iso');
            const ct = cleanGameTitle(fn);
            if (!isNonGame(ct, iso, path.dirname(iso))) allGames.push({ id: generateId(iso), title: ct, exePath: iso, installDir: path.dirname(iso), platform: 'iso', updateFiles: await findUpdateFilesForIso(ctx, iso) });
          }
        } catch (e) { ctx.logger.error(`Error scanning ISO path ${dir}: ${e?.message ?? e}`); }
        idx++;
      }

      _scanProgress = { phase: 'done', current: total, total: total || 1 };
      ctx.host.emit('scan:progress', { currentDir: 'Done', progress: 100 });
      const games = deduplicate(allGames);
      return { success: true, games, total: games.length };
    },

    'scan.status': async (ctx) => _scanProgress
  },

  status: async (ctx) => {
    const dirs = await ctx.config.get('scanDirectories') || [];
    const isoDirs = await ctx.config.get('isoDirectories') || [];
    return { connected: true, scanDirectories: Array.isArray(dirs) ? dirs.length : 0, isoDirectories: Array.isArray(isoDirs) ? isoDirs.length : 0 };
  },

  test: async (ctx) => {
    // Verify the plugin can access its own config without throwing
    try {
      const dirs = ctx.config.get('scanDirectories');
      const isoDirs = ctx.config.get('isoDirectories');
      return { passed: true };
    } catch (e) {
      return { passed: false, failures: [e.message] };
    }
  },

  slotRender: async (ctx, location) => ({
    type: 'scan', platform: 'pc-directory', label: 'Local Files', platforms: ['pc', 'steam', 'iso', 'xbox', 'epic', 'gog', 'battlenet', 'ubisoft', 'ea', 'riot', 'itch'],
    description: 'Scan local folders for Steam, PC, and ISO games',
    mediaTypes: ['games'],
    actions: { scan: 'scan', status: 'scan.status' },
    configFields: [
      { key: 'scanDirectories', label: 'Game Directories', type: 'path-list', description: 'Folders to scan for game executables and Steam manifests' },
      { key: 'isoDirectories', label: 'ISO Directories', type: 'path-list', description: 'Folders containing ISO game files to scan' },
    ],
  }),
};
