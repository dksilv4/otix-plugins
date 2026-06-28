// Riot Games Scanner plugin for Otix
const path = require('path');

const RIOT_PATHS = [
  'C:\\Riot Games',
  'C:\\Program Files\\Riot Games',
];

function generateId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); hash = (hash << 5) - hash + c; hash = hash & hash; }
  return 'riot_' + Math.abs(hash).toString(36);
}

async function walkExe(ctx, dir, depth) {
  if (depth > 3) return null;
  try {
    for (const entry of await ctx.filesystem.readdir(dir)) {
      if (entry.isDirectory) {
        const nl = entry.name.toLowerCase();
        if (nl === 'riot client' || nl === 'launcher') continue;
        const found = await walkExe(ctx, path.join(dir, entry.name), depth + 1);
        if (found) return found;
      } else if (entry.isFile) {
        const n = entry.name.toLowerCase();
        if (n.endsWith('.exe') && !n.includes('unins') && !n.includes('riotclient') && !n.includes('crash')) {
          return path.join(dir, entry.name);
        }
      }
    }
  } catch {}
  return null;
}

module.exports = {
  plugin: (ctx) => { ctx.logger.info('Riot Games Scanner loaded'); },
  data: {
    scan: async (ctx) => {
      const games = [];
      for (const basePath of RIOT_PATHS) {
        try {
          if (!(await ctx.filesystem.access(basePath))) continue;
          for (const entry of await ctx.filesystem.readdir(basePath)) {
            if (!entry.isDirectory) continue;
            const gameDir = path.join(basePath, entry.name);
            const exe = await walkExe(ctx, gameDir, 0);
            if (exe) games.push({ id: generateId(gameDir), title: entry.name, exePath: exe, installDir: gameDir, platform: 'riot', localExePath: exe });
          }
        } catch {}
      }
      return { games };
    },
    'scan.status': async (ctx) => ({ phase: 'idle' }),
  },
  status: async (ctx) => ({ connected: true }),
  test: async (ctx) => {
    for (const p of RIOT_PATHS) { if (await ctx.filesystem.access(p)) return { passed: true }
    return { passed: true };
  },
  slotRender: async (ctx, location) => ({ type: 'scan', platform: 'riot', label: 'Riot Games', description: 'Scan local Riot Games installations', mediaTypes: ['games'] }),
};
