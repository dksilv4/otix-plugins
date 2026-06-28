// Battle.net Scanner plugin for Otix
// Scans local Battle.net game installations for matching.

const path = require('path');

const BATTLENET_PATHS = [
  'C:\\Program Files (x86)\\Battle.net\\Games',
  'C:\\Program Files\\Battle.net\\Games',
  'C:\\Battle.net\\Games',
];

function generateId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return 'bnet_' + Math.abs(hash).toString(36);
}

function cleanGameTitle(name) {
  return name.replace(/[\._\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Plugin exports ────────────────────────────────────────────────────

module.exports = {
  plugin: (ctx) => {
    ctx.logger.info('Battle.net Scanner loaded');
  },

  data: {
    scan: async (ctx) => {
      const games = [];
      let idx = 0;
      const total = BATTLENET_PATHS.length;
      const emit = (dir) => ctx.host.emit('scan:progress', {
        currentDir: dir, progress: total > 0 ? Math.round((idx / total) * 100) : 100,
      });

      for (const basePath of BATTLENET_PATHS) {
        emit(basePath);
        try {
          if (!(await ctx.filesystem.access(basePath))) { idx++; continue; }
          const entries = await ctx.filesystem.readdir(basePath);
          for (const entry of entries) {
            if (!entry.isDirectory) continue;
            const gameDir = path.join(basePath, entry.name);

            // Battle.net games often have _retail_ or _classic_ subdirectories
            const candidates = [gameDir];
            try {
              for (const sub of await ctx.filesystem.readdir(gameDir)) {
                if (sub.isDirectory && sub.name.startsWith('_')) {
                  candidates.push(path.join(gameDir, sub.name));
                }
              }
            } catch {}

            for (const candidateDir of candidates) {
              try {
                const files = await ctx.filesystem.readdir(candidateDir);
                for (const file of files) {
                  if (!file.isFile) continue;
                  const n = file.name.toLowerCase();
                  if (n.endsWith('.exe') && !n.includes('unins') && !n.includes('crash') && !n.includes('agent')) {
                    games.push({
                      id: generateId(gameDir),
                      title: cleanGameTitle(entry.name),
                      exePath: path.join(candidateDir, file.name),
                      installDir: gameDir,
                      platform: 'battlenet',
                      localExePath: path.join(candidateDir, file.name),
                    });
                    break;
                  }
                }
              } catch {}
              if (candidates.length > 1) break; // found in _retail_ subdir
            }
          }
        } catch (e) { ctx.logger.error(`Error scanning ${basePath}: ${e.message}`); }
        idx++;
      }

      ctx.host.emit('scan:progress', { currentDir: 'Done', progress: 100 });
      return { games };
    },

    'scan.status': async (ctx) => ({ phase: 'idle' }),
  },

  status: async (ctx) => ({ connected: true, scanPaths: BATTLENET_PATHS.length }),

  test: async (ctx) => {
    for (const p of BATTLENET_PATHS) {
      if (await ctx.filesystem.access(p)) return { passed: true };
    }
    return { passed: true };
  },

  slotRender: async (ctx, location) => ({
    type: 'scan', platform: 'battlenet', label: 'Battle.net',
    description: 'Scan local Battle.net game installations',
    mediaTypes: ['games'],
  }),
};
