function isFullGame(result) {
  var title = result.title.toLowerCase();
  return !['demo', 'trial', 'beta', 'alpha'].some(function(p) { return title.includes(p); });
}

function hasSceneTags(result) {
  var title = result.title.toLowerCase();
  return ['iso', 'repack', 'codex', 'crack', 'gog', 'elamigos', 'dodi', 'fitgirl', 'skidrow', 'flt']
    .some(function(tag) { return title.includes(tag); });
}

function hasPreferredRepacker(result, repackers) {
  if (!repackers || repackers.length === 0) return false;
  var title = result.title.toLowerCase();
  return repackers.some(function(r) { return title.includes(r.toLowerCase()); });
}

function hasHypervisorTags(result) {
  var title = result.title.toLowerCase();
  return ['hv', 'hypervisor', 'vm', 'vmware', 'virtualbox', 'qemu', 'vmic'].some(function(tag) {
    if (tag === 'hv') return title.includes(' hv ') || title.startsWith('hv ');
    return title.includes(tag);
  });
}

function isNotCrackOnly(result) {
  var title = result.title.toLowerCase();
  return !['crack by', 'crack-only', 'crack only', 'crackfix', 'standalone crack']
    .some(function(p) { return title.includes(p); });
}

function filterQualityResults(results) {
  var filtered = results.filter(function(r) { return isFullGame(r) && isNotCrackOnly(r); });
  return filtered.length > 0 ? filtered : results;
}

function autoPickBest(results, preferredRepackers, allowHypervisor) {
  var quality = filterQualityResults(results);
  if (quality.length === 0) return null;

  if (!allowHypervisor) {
    quality = quality.filter(function(r) { return !hasHypervisorTags(r); });
    if (quality.length === 0) return null;
  }

  var repackerList = preferredRepackers
    ? preferredRepackers.split(',').map(function(r) { return r.trim(); }).filter(Boolean)
    : [];

  function rank(list) {
    var scene = list.filter(function(r) { return hasSceneTags(r); });
    var nonScene = list.filter(function(r) { return !hasSceneTags(r); });
    return scene.concat(nonScene);
  }

  if (repackerList.length > 0) {
    var preferred = quality.filter(function(r) { return hasPreferredRepacker(r, repackerList); });
    var others = quality.filter(function(r) { return !hasPreferredRepacker(r, repackerList); });
    return rank(preferred).concat(rank(others))[0];
  }

  return rank(quality)[0];
}

module.exports = { filterQualityResults: filterQualityResults, autoPickBest: autoPickBest,
  isFullGame: isFullGame, hasSceneTags: hasSceneTags, hasPreferredRepacker: hasPreferredRepacker,
  hasHypervisorTags: hasHypervisorTags, isNotCrackOnly: isNotCrackOnly };
