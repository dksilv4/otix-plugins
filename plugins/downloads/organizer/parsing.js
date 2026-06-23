var CORE_SKIP_WORDS = new Set([
  'repack', 'codex', 'crack', 'gog', 'elamigos', 'dodi', 'fitgirl',
  'skidrow', 'flt', 'update', 'patch', 'hotfix', 'dlc', 'addon', 'iso',
  'program', 'game', 'install', 'setup', 'files', 'data', 'content',
]);

function gameSignature(title) {
  return title.toLowerCase()
    .replace(/\s*password=.*$/i, '')
    .replace(/-[a-z0-9_.]+$/, '')
    .replace(/\b(update|patch|hotfix|demo|dlc|addon|repack)\b/gi, '')
    .replace(/\bv?\d+(\.\d+)*\b/gi, '')
    .split(/[.\s]+/)
    .filter(function(w) { return w && !CORE_SKIP_WORDS.has(w); })
    .map(function(w) { return w.replace(/[^a-z0-9]/g, ''); })
    .filter(Boolean)
    .join('');
}

function extractGroup(title) {
  var lower = title.toLowerCase().trim();
  var pwMatch = lower.match(/password=([a-z0-9_.]+)/);
  var cleaned = lower.replace(/\s*password=.*$/i, '').trim();
  var dashMatch = cleaned.match(/-([a-z0-9_.]+)$/);
  if (dashMatch) return dashMatch[1];
  var words = cleaned.split(/\s+/).filter(Boolean);
  var last = words[words.length - 1];
  if (last && CORE_SKIP_WORDS.has(last)) return last;
  if (last && /^[a-z]{2,10}$/.test(last) && !/^\d+$/.test(last)) return last;
  if (pwMatch && pwMatch[1].length >= 2 && pwMatch[1].length <= 15) return pwMatch[1];
  return null;
}

function parseVersion(title) {
  var lower = title.toLowerCase();
  var m = lower.match(/\bv(\d{3,})\b/);
  if (m) return parseInt(m[1], 10);
  m = lower.match(/\bupdate\s+(\d{3,})/);
  if (m) return parseInt(m[1], 10);
  return null;
}

var EDITION_RE = /(?<edition>goty|game\s*of\s*the\s*year|definitive|enhanced|remastered|ultimate|complete|deluxe|collectors|special|legendary|anniversary)\s*edition/gi;

function parseReleaseName(rawName) {
  var m;

  // Strategy 1: Scene format
  m = rawName.match(/^(?<title>[A-Za-z0-9._+\-]+?)\.?(?:v?(?<version>\d+(?:\.\d+)*))?[._-]?(?<extra>REPACK|PROPER|UPDATE|MULTI\d*|GOTY|DEF|ENHANCED)?[._-](?<group>[A-Za-z0-9]{2,20})$/);
  if (m && m.groups) {
    var g = m.groups;
    var title = g.title.replace(/[._]/g, ' ').trim();
    var edMatch = title.match(EDITION_RE);
    var edition = edMatch ? edMatch[0].trim() : undefined;
    if (edition) title = title.replace(edition, '').trim();
    var yearMatch = title.match(/\b(?<year>(?:19|20)\d{2})\b/);
    return { title: title.replace(/\s+/g, ' ').trim(), cleanTitle: gameSignature(rawName),
      year: yearMatch && yearMatch.groups ? yearMatch.groups.year : undefined,
      edition: edition, group: g.group || undefined, version: g.version || undefined,
      rawName: rawName, isScene: true };
  }

  // Strategy 2: Elamigos format
  m = rawName.match(/^(?<title>.+?)\s+(?:v?(?<version>\d{3,}))?\s*(?<group>[A-Za-z0-9]+?)(?:\s+password=.*)?$/i);
  if (m && m.groups) {
    var title = m.groups.title.trim();
    var edMatch = title.match(EDITION_RE);
    var edition = edMatch ? edMatch[0].trim() : undefined;
    if (edition) title = title.replace(edition, '').trim();
    var yearMatch = title.match(/\b(?<year>(?:19|20)\d{2})\b/);
    return { title: title.replace(/\s+/g, ' ').trim(), cleanTitle: gameSignature(rawName),
      year: yearMatch ? yearMatch[1] : undefined, edition: edition,
      group: m.groups.group || undefined, version: m.groups.version || undefined,
      rawName: rawName, isScene: false };
  }

  // Strategy 3: Year in brackets
  m = rawName.match(/^(?<title>.+?)\s*[\[\(](?<year>(?:19|20)\d{2})[\]\)]/);
  if (m && m.groups) {
    var title = m.groups.title.replace(/[._]/g, ' ').trim();
    var edMatch = title.match(EDITION_RE);
    var edition = edMatch ? edMatch[0].trim() : undefined;
    if (edition) title = title.replace(edition, '').trim();
    var platMatch = rawName.match(/\[(?<platform>Multi|PC|PS\d|Xbox|Switch|Steam|GOG|Android|iOS)\]/i);
    return { title: title.replace(/\s+/g, ' ').trim(), cleanTitle: gameSignature(rawName),
      year: m.groups.year, edition: edition, platform: platMatch ? platMatch[1] : undefined,
      group: extractGroup(rawName) || undefined, version: parseVersion(rawName) ? String(parseVersion(rawName)) : undefined,
      rawName: rawName, isScene: false };
  }

  // Strategy 4: Fallback
  var title = gameSignature(rawName);
  var edMatch = rawName.match(EDITION_RE);
  var edition = edMatch ? edMatch[0].trim() : undefined;
  var yearBracket = rawName.match(/[\[\(](?<year>(?:19|20)\d{2})[\]\)]/);
  var yearEnd = rawName.match(/(?:\s|\.)(?<year>(?:19|20)\d{2})(?:\s*\.\w+)?$/);
  return { title: title.replace(/\s+/g, ' ').trim(), cleanTitle: title,
    year: yearBracket ? yearBracket[1] : (yearEnd ? yearEnd[1] : undefined),
    edition: edition, group: extractGroup(rawName) || undefined,
    version: parseVersion(rawName) ? String(parseVersion(rawName)) : undefined,
    rawName: rawName, isScene: false };
}

module.exports = { parseReleaseName: parseReleaseName, gameSignature: gameSignature,
  extractGroup: extractGroup, parseVersion: parseVersion };
