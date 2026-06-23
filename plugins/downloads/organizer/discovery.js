var path = require('path');
var SKIP_DIRS = new Set(['node_modules', 'bower_components', '.git', '.github', '.svn', '.hg',
  'system32', 'syswow64', 'windows', 'microsoft.net', 'appdata',
  'obj', 'bin', '__pycache__', '.venv', 'venv', 'env', 'windowsapps']);

async function findDownloadedContent(dirPath, maxDepth) {
  if (maxDepth === undefined) maxDepth = 3;
  var results = [];
  var seen = new Set();
  var fs = require('fs/promises');

  async function traverse(currentDir, depth) {
    if (depth > maxDepth) return;
    try {
      var entries = await fs.readdir(currentDir, { withFileTypes: true });
      var hasExe = false;
      var childDirs = [];
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var fullPath = path.join(currentDir, entry.name);
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
          if (depth < maxDepth) childDirs.push(fullPath);
        } else if (entry.isFile()) {
          var nameLower = entry.name.toLowerCase();
          if (nameLower.endsWith('.iso')) {
            results.push({ path: fullPath, name: entry.name, type: 'iso' });
          } else if (nameLower.endsWith('.exe') && (nameLower.includes('update') || nameLower.includes('patch')) && !nameLower.includes('setup') && !nameLower.includes('uninst') && !nameLower.includes('helper')) {
            results.push({ path: fullPath, name: entry.name, type: 'update' });
          } else if (nameLower.endsWith('.exe') && !nameLower.includes('setup') && !nameLower.includes('uninst') && !nameLower.includes('helper')) {
            hasExe = true;
          }
        }
      }
      if (hasExe) results.push({ path: currentDir, name: path.basename(currentDir), type: 'pc_game' });
      for (var j = 0; j < childDirs.length; j++) await traverse(childDirs[j], depth + 1);
    } catch(e) { /* skip */ }
  }

  await traverse(dirPath, 1);
  return results;
}

module.exports = { findDownloadedContent: findDownloadedContent };
