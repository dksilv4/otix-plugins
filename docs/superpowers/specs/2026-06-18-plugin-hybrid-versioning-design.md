# Plugin Hybrid Versioning Scheme

## Summary

Replace arbitrary `x.y.z` plugin versions with a hybrid `<otix-version>.<plugin-patch>` scheme that ties plugin versions to the Otix app version they target, making compatibility explicit and version bumps meaningful.

## Version Format

```
<otix-major>.<otix-minor>.<otix-patch>.<plugin-iteration>
```

| Component | Source | Meaning | When to bump |
|-----------|--------|---------|-------------|
| `otix-major` | Otix app | Major app release | Otix major bump |
| `otix-minor` | Otix app | Minor app release | Otix minor bump |
| `otix-patch` | Otix app | Always `0` for plugins | Reserved |
| `plugin-iteration` | Plugin | Any plugin change | Every plugin release |

### Examples

| Version | Meaning |
|---------|---------|
| `0.3.0.1` | Targeting Otix v0.3.x, first plugin release |
| `0.3.0.2` | Still Otix v0.3.x, bug fix or minor improvement |
| `0.4.0.1` | Targeting Otix v0.4.x, first release for this app version |

## Compatibility Enforcement

### Check logic

At install time and enable time, compare the first three components of the plugin version against the running app version:

```
plugin_target = extract(plugin_version, 3)   // e.g. "0.3.0" from "0.3.0.1"
app_version = app.getVersion()                // e.g. "0.3.5"
is_compatible = semver_satisfies(app_version, ">=" + plugin_target)
```

If incompatible:
- **Install**: Block with message: `"Plugin requires Otix v{target} or higher"`
- **Enable**: Block with message, set status to `error`

### `min_app_version` field

The `min_app_version` field in `manifest.json` is replaced by extracting the target from the hybrid version. Remove the separate `min_app_version` field — the version itself carries this info.

### Backward compatibility

Existing plugins with SemVer versions (e.g., `1.0.0`) are assumed compatible with any app version. Only the new hybrid format (`x.y.z.w`) triggers strict checking.

## Registry Changes

`registry.json` entries now show the hybrid version. The `min_app_version` field in the registry is deprecated — the version carries the same info.

## Migration

- Radarr plugin: `1.0.0` → `0.3.0.2` (second iteration for Otix 0.3.x)
- Hello World plugin: `1.0.0` → `0.3.0.1` (first iteration for Otix 0.3.x)
- All future plugins start at `<current-otix-version>.1`

## Implementation

### Files to modify

1. **`desktop/plugins/manager.ts`** — Add `checkPluginCompatibility(pluginVersion)` that extracts the Otix target and compares with `app.getVersion()`. Call during `installFromGit()` and `enable()`.
2. **`desktop/plugins/types.ts`** — Update JSDoc to document the hybrid format. Consider adding `PluginVersion` type alias.
3. **`desktop/plugins/loader.ts`** — Call compatibility check during `loadPluginMain()`.
4. **`desktop/plugins/marketplace.ts`** — Deprecate `min_app_version` in `RegistryEntry`.
5. **`otix-plugins/registry.json`** — Update versions.
6. **`otix-plugins/plugins/otix-radarr/manifest.json`** — Update to `0.3.0.2`.
7. **`otix-plugins/plugins/otix-hello/manifest.json`** — Update to `0.3.0.1`.

### Compatibility check function

```typescript
function checkPluginCompatibility(pluginVersion: string, appVersion: string): { ok: boolean; required?: string } {
  // Old-style SemVer (e.g. "1.0.0") — skip check, assume compatible
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(pluginVersion)) {
    return { ok: true };
  }

  // Extract first 3 components as the target Otix version
  const parts = pluginVersion.split('.');
  const required = `${parts[0]}.${parts[1]}.${parts[2]}`;

  // Compare using semver
  try {
    const ok = semver.gte(appVersion, required);
    return { ok, required };
  } catch {
    return { ok: true }; // fallback: don't block on parse errors
  }
}
```
