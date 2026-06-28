// Itch.io Scanner plugin for Otix
const path = require('path');

const ITCH_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'itch', 'apps')
  : '';

function generateId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); hash = (hash << 5) - hash + c; hash = hash & hash; }
  return 'itch_' + Math.abs(hash).toString(36);
}

module.exports = {
  plugin: (ctx) => { ctx.logger.info('Itch.io Scanner loaded'); },
  data: {
    scan: async (ctx) => {
      const games = [];
      if (!ITCH_DIR) return { games };
      try {
        if (!(await ctx.filesystem.access(ITCH_DIR))) return { games };
        for (const entry of await ctx.filesystem.readdir(ITCH_DIR)) {
          if (!entry.isDirectory) continue;
          const gameDir = path.join(ITCH_DIR, entry.name);
          // Try to read .itch metadata file for clean title
          let title = entry.name;
          try {
            for (const f of await ctx.filesystem.readdir(gameDir)) {
              if (f.isFile && f.name.endsWith('.itch')) {
                title = f.name.replace('.itch', '');
                break;
              }
            }
          } catch {}
          // Find executable
          let exePath = '';
          try {
            const walkDir = async (dir, depth) => {
              if (exePath || depth > 2) return;
              for (const f of await ctx.filesystem.readdir(dir)) {
                if (exePath) return;
                if (f.isDirectory) await walkDir(path.join(dir, f.name), depth + 1);
                else if (f.isFile) {
                  const n = f.name.toLowerCase();
                  if (n.endsWith('.exe') && !n.includes('unins')) exePath = path.join(dir, f.name);
                }
              }
            };
            await walkDir(gameDir, 0);
          } catch {}
          games.push({ id: generateId(gameDir), title, exePath: exePath || gameDir, installDir: gameDir, platform: 'itch', localExePath: exePath || undefined });
        }
      } catch (e) { ctx.logger.error(`Error scanning Itch directory: ${e.message}`); }
      return { games };
    },
    'scan.status': async (ctx) => ({ phase: 'idle' }),
  },
  status: async (ctx) => {
    const exists = ITCH_DIR ? await ctx.filesystem.access(ITCH_DIR).catch(() => false) : false;
    return { connected: exists };
  },
  test: async (ctx) => {
    if (!ITCH_DIR) return { passed: false, failures: ['APPDATA not set'] };
    if (await ctx.filesystem.access(ITCH_DIR)) return { passed: true };
    return { passed: true };
  },
  slotRender: async (ctx, location) => ({ type: 'scan', platform: 'itch', label: 'Itch.io', description: 'Scan local Itch.io game installations', mediaTypes: ['games'] }),
};
