var NAMING_PRESETS = {
  standard: { label: 'Standard (arr-style)', template: '{Title} ({Year}) [{Platform}]/{OriginalName}.{ext}' },
  scene: { label: 'Scene Standard', template: '{Title}/{Title}.v{Version}-{ReleaseGroup}.{ext}' },
  simple: { label: 'Simple', template: '{Title}/{Title}.{ext}' },
  yearFlat: { label: 'Flat by Year', template: '{Title} ({Year})/{Title}.{ext}' },
  folderOnly: { label: 'Smart Folder', template: '{Title} ({Year}) [{Platform}]/{OriginalName}.{ext}' },
};

var VALID_TOKENS = new Set(['Title', 'CleanTitle', 'Year', 'Edition', 'Platform',
  'ReleaseGroup', 'Version', 'OriginalName', 'MediaType', 'ext']);

function applyNamingTemplate(release, template, fileInfo, baseDir) {
  var tokens = {
    Title: release.title || '', CleanTitle: release.cleanTitle || '',
    Year: release.year || '', Edition: release.edition || '',
    Platform: release.platform || 'PC', ReleaseGroup: release.group || '',
    Version: release.version || '', OriginalName: release.rawName || '',
    MediaType: fileInfo.type === 'iso' ? 'ISO' : fileInfo.type === 'pc_game' ? 'PC' : 'Update',
    ext: fileInfo.ext || '',
  };
  var result = template;
  for (var key in tokens) {
    if (tokens.hasOwnProperty(key)) {
      result = result.replace(new RegExp('\\{' + key + '\\}', 'g'), tokens[key] || '');
    }
  }
  result = result.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').replace(/\{\s*\}/g, '');
  result = result.replace(/[\\/]+/g, '/').replace(/\/$/, '').replace(/\s{2,}/g, ' ').replace(/\s+\//g, '/').replace(/\/\s+/g, '/').replace(/\.$/, '').trim();
  return baseDir ? (baseDir + '/' + result).replace(/[\\/]+/g, '/') : result;
}

function validateNamingTemplate(template) {
  var found = template.match(/\{(\w+)\}/g) || [];
  for (var i = 0; i < found.length; i++) {
    if (!VALID_TOKENS.has(found[i].slice(1, -1))) return { valid: false, error: 'Unknown token: ' + found[i] };
  }
  if (!template.includes('{Title}') && !template.includes('{CleanTitle}')) {
    return { valid: false, error: 'Template must include {Title} or {CleanTitle}' };
  }
  return { valid: true };
}

module.exports = { applyNamingTemplate: applyNamingTemplate, validateNamingTemplate: validateNamingTemplate,
  NAMING_PRESETS: NAMING_PRESETS };
