var parsing = require('./parsing');
var naming = require('./naming');
var discovery = require('./discovery');

async function autoOrganizeDownload(downloadDir, namingTemplate, destBase) {
  var val = naming.validateNamingTemplate(namingTemplate);
  if (!val.valid) return { success: false, organized: [], errors: [val.error] };

  var content = await discovery.findDownloadedContent(downloadDir, 5);
  if (content.length === 0) return { success: false, organized: [], errors: ['No content found'] };

  var baseName = downloadDir.split('/').pop().split('\\').pop();
  var release = parsing.parseReleaseName(baseName);
  var organized = [];

  for (var i = 0; i < content.length; i++) {
    var item = content[i];
    var fileInfo, target;
    if (item.type === 'pc_game') {
      fileInfo = { name: item.name, ext: '', type: 'pc_game' };
      var folderTemplate = namingTemplate.split('/').slice(0, -1).join('/') || namingTemplate;
      target = naming.applyNamingTemplate(release, folderTemplate, fileInfo, destBase);
    } else {
      fileInfo = { name: item.name, ext: item.name.includes('.') ? item.name.split('.').pop() : '', type: item.type };
      target = naming.applyNamingTemplate(release, namingTemplate, fileInfo, destBase);
    }
    organized.push({ from: item.path, to: target, type: item.type });
  }

  return { success: true, organized: organized, errors: [] };
}

module.exports = { autoOrganizeDownload: autoOrganizeDownload };
