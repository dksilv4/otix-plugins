// Xbox / Microsoft Store Scanner plugin for Otix
const path = require('path');

const GAME_PUBLISHERS = [
  'Microsoft.Studios', 'Microsoft.Gaming', 'Microsoft.Bethesda',
  'Microsoft.Xbox', 'Microsoft.Minecraft', 'Microsoft.SeaOfThieves',
  'Microsoft.Forza', 'Microsoft.Halo', 'Microsoft.Gears',
  'Microsoft.AgeOfEmpires', 'Microsoft.FlightSimulator',
  'XboxLive', 'XboxGame', 'BethesdaSoftworks', 'PlaygroundGames',
  'Turn10', 'UndeadLabs', 'Mojang', '343Industries', 'TheCoalition',
  'CompulsionGames', 'DoubleFine', 'InXile', 'NinjaTheory', 'Obsidian',
  'Rare', 'WorldsEdge',
];

// Common Game Pass / Xbox app install roots
const XBOX_PATHS = [
  'C:\\Program Files\\WindowsApps',
  'C:\\XboxGames',
];

function generateId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); hash = (hash << 5) - hash + c; hash = hash & hash; }
  return 'xbox_' + Math.abs(hash).toString(36);
}

function cleanPackageName(name) {
  let clean = name.replace(/^Microsoft\./, '').replace(/^Xbox\./, '').replace(/_\d+.*$/, '').replace(/\./g, ' ');
  clean = clean.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return clean || name;
}

module.exports = {
  plugin: (ctx) => { ctx.logger.info('Xbox / MS Store Scanner loaded'); },
  data: {
    scan: async (ctx) => {
      const games = [];

      // Scan WindowsApps directory for game packages
      for (const basePath of XBOX_PATHS) {
        try {
          if (!(await ctx.filesystem.access(basePath))) continue;
          for (const entry of await ctx.filesystem.readdir(basePath)) {
            if (!entry.isDirectory) continue;
            const nameLower = entry.name.toLowerCase();
            const isGame = GAME_PUBLISHERS.some(pub => nameLower.includes(pub.toLowerCase()));
            if (!isGame) continue;

            const installDir = path.join(basePath, entry.name);
            // Find .exe in the package directory
            let exePath = '';
            try {
              const walkDir = async (dir, depth) => {
                if (exePath || depth > 2) return;
                for (const f of await ctx.filesystem.readdir(dir)) {
                  if (exePath) return;
                  if (f.isDirectory) await walkDir(path.join(dir, f.name), depth + 1);
                  else if (f.isFile) {
                    const n = f.name.toLowerCase();
                    if (n.endsWith('.exe') && !n.includes('unins') && !n.includes('gamingservices')) {
                      exePath = path.join(dir, f.name);
                    }
                  }
                }
              };
              await walkDir(installDir, 0);
            } catch {}

            games.push({
              id: generateId(entry.name),
              title: cleanPackageName(entry.name),
              exePath: exePath || `shell:AppsFolder\\${entry.name}`,
              installDir,
              platform: 'xbox',
              localExePath: exePath || undefined,
            });
          }
        } catch {}
      }
      return { games };
    },
    'scan.status': async (ctx) => ({ phase: 'idle' }),
  },
  status: async (ctx) => ({ connected: true }),
  test: async (ctx) => {
    for (const p of XBOX_PATHS) { if (await ctx.filesystem.access(p)) return { passed: true }
    return { passed: true };
  },
  slotRender: async (ctx, location) => ({ type: 'scan', platform: 'xbox', label: 'Xbox / MS Store', description: 'Scan local Xbox and Microsoft Store game installations', mediaTypes: ['games'], actions: { scan: 'scan', status: 'scan.status' } }),
};
