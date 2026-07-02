// Ubisoft Connect Scanner plugin for Otix
const path = require('path');

const UBI_PATHS = [
  'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\game',
  'C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\game',
];

function generateId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); hash = (hash << 5) - hash + c; hash = hash & hash; }
  return 'ubi_' + Math.abs(hash).toString(36);
}

module.exports = {
  plugin: (ctx) => { ctx.logger.info('Ubisoft Connect Scanner loaded'); },
  data: {
    scan: async (ctx) => {
      const games = [];
      for (const basePath of UBI_PATHS) {
        try {
          if (!(await ctx.filesystem.access(basePath))) continue;
          for (const entry of await ctx.filesystem.readdir(basePath)) {
            if (!entry.isDirectory) continue;
            const gameDir = path.join(basePath, entry.name);
            try {
              for (const file of await ctx.filesystem.readdir(gameDir)) {
                if (!file.isFile) continue;
                const n = file.name.toLowerCase();
                if (n.endsWith('.exe') && !n.includes('unins') && !n.includes('upc') && !n.includes('ubisoft')) {
                  games.push({ id: generateId(gameDir), title: entry.name, exePath: path.join(gameDir, file.name), installDir: gameDir, platform: 'ubisoft' });
                  break;
                }
              }
            } catch {}
          }
        } catch {}
      }
      return { games };
    },
    'scan.status': async (ctx) => ({ phase: 'idle' }),
  },
  status: async (ctx) => ({ connected: true }),
  test: async (ctx) => {
    for (const p of UBI_PATHS) { if (await ctx.filesystem.access(p)) return { passed: true }
    return { passed: true };
  },
  slotRender: async (ctx, location) => ({ type: 'scan', platform: 'ubisoft', label: 'Ubisoft Connect', description: 'Scan local Ubisoft Connect game installations', mediaTypes: ['games'], actions: { scan: 'scan', status: 'scan.status' } }),
};
