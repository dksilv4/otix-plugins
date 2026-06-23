// EA App Scanner plugin for Otix
const path = require('path');

const EA_PATHS = [
  'C:\\Program Files\\EA Games',
  'C:\\Program Files (x86)\\EA Games',
  'C:\\Program Files\\Electronic Arts',
  'C:\\Program Files (x86)\\Origin Games',
];

function generateId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); hash = (hash << 5) - hash + c; hash = hash & hash; }
  return 'ea_' + Math.abs(hash).toString(36);
}

async function walk(ctx, dir, depth) {
  const exes = [];
  if (depth > 3) return exes;
  try {
    for (const entry of await ctx.filesystem.readdir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory) {
        exes.push(...await walk(ctx, full, depth + 1));
      } else if (entry.isFile) {
        const n = entry.name.toLowerCase();
        if (n.endsWith('.exe') && !n.includes('unins') && !n.includes('activation') && !n.includes('touchup') && !n.includes('cleanup') && !n.includes('crash')) {
          exes.push(full);
        }
      }
    }
  } catch {}
  return exes;
}

module.exports = {
  plugin: (ctx) => { ctx.logger.info('EA App Scanner loaded'); },
  data: {
    scan: async (ctx) => {
      const games = [];
      for (const basePath of EA_PATHS) {
        try {
          if (!(await ctx.filesystem.access(basePath))) continue;
          for (const entry of await ctx.filesystem.readdir(basePath)) {
            if (!entry.isDirectory) continue;
            const gameDir = path.join(basePath, entry.name);
            const exes = await walk(ctx, gameDir, 0);
            if (exes.length > 0) {
              games.push({ id: generateId(gameDir), title: entry.name, exePath: exes[0], installDir: gameDir, platform: 'ea', localExePath: exes[0] });
            }
          }
        } catch (e) { ctx.logger.error(`Error scanning EA path: ${e.message}`); }
      }
      return { games };
    },
    'scan.status': async (ctx) => ({ phase: 'idle' }),
  },
  status: async (ctx) => ({ connected: true }),
  test: async (ctx) => {
    for (const p of EA_PATHS) { if (await ctx.filesystem.access(p)) return { success: true, message: 'EA directory found' }; }
    return { success: true, message: 'No EA installation detected' };
  },
  slotRender: async (ctx, location) => ({ type: 'scan', platform: 'ea', label: 'EA App', description: 'Scan local EA App game installations' }),
};
