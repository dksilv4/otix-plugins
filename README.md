# Otix Plugin Marketplace

Community plugins for the [Otix](https://github.com/dksilv4/Otix) desktop app. Browse and install plugins directly from Otix Settings → Plugins → Browse Marketplace.

## Available Plugins

| Plugin | Description | Category |
|---|---|---|
| [Radarr Sync](plugins/otix-radarr/) | Auto-download movies via Radarr from your Otix watchlist | media |
| [Hello World](plugins/otix-hello/) | Demo plugin showing all plugin system features | developer |

## Plugin Structure

Each plugin lives under `plugins/<id>/` and requires:

```
plugins/my-plugin/
  manifest.json    # Plugin metadata, permissions, config schema
  main.js          # Plugin entry point (CommonJS)
```

See [Radarr Sync](plugins/otix-radarr/) for a complete example.

## Adding Your Plugin

1. Fork this repo
2. Create a directory under `plugins/<your-plugin-id>/`
3. Add `manifest.json` and `main.js`
4. Add your plugin entry to `registry.json`
5. Open a PR

### manifest.json

```json
{
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does",
  "author": "Your Name",
  "repository": "https://github.com/dksilv4/otix-plugins",
  "min_app_version": "0.3.0",
  "permissions": ["events:subscribe", "storage:local", "ui:settings"],
  "config": { "my_option": { "type": "string", "label": "My Option" } },
  "entry": { "main": "main.js" }
}
```

### main.js

```javascript
// Plugins MUST export a default function (the entry point) AND a
// "test" function. Without a passing test, the plugin cannot be enabled.

const entry = function(ctx) {
  // Plugin context: ctx.config, ctx.events, ctx.db, ctx.api, ctx.fetch,
  //                 ctx.notifications, ctx.logger, ctx.handle, ctx.call,
  //                 ctx.host.emit, ctx.onDestroy

  ctx.logger.info('Plugin started');

  ctx.onDestroy(() => {
    ctx.logger.info('Plugin stopped');
  });
};

// ── Mandatory test export ─────────────────────────────────────────
// ALL plugins must export a "test" function. It runs before the plugin
// is enabled. Return { passed: boolean, failures?: string[] }.
//
// If passed is false, the plugin stays disabled and the failure reasons
// are shown to the user. If the test export is missing entirely, the
// plugin is rejected with a descriptive error.
entry.test = async function(ctx) {
  const failures = [];

  // Test core logic (pure functions, config validation, etc.)
  if (1 + 1 !== 2) failures.push('Math is broken');

  // Test external connectivity if needed (with timeout)
  // try { await ctx.fetch('https://example.com'); } catch { failures.push('Network unreachable'); }

  return { passed: failures.length === 0, failures };
};

module.exports = entry;
```

#### Test Requirements

Every plugin **must** export a `test` function. This is enforced at enable time:

| Rule | |
|---|---|
| **Signature** | `test(ctx) => Promise<{ passed: boolean, failures?: string[] }>` |
| **Runs** | Every time the plugin is enabled (startup + manual enable) |
| **Passing** | Return `{ passed: true }` (failures array empty or omitted) |
| **Failing** | Return `{ passed: false, failures: ['reason 1', 'reason 2'] }` |
| **Missing** | Plugin is rejected — "must export a test function" |
| **Timeout** | 60s (same as any RPC call). Keep tests fast. |

Good tests check: config schema assumptions, pure function correctness, required binaries exist (don't crash), edge cases (empty input, null values). Avoid: long network calls, spawning real processes that may hang.

#### Optional: config connection test

For plugins that want a user-initiated connection test (e.g., "Test Connection" button in settings), the same `test` function can handle it — the settings UI calls it with a config draft:

```javascript
entry.test = async function(ctx, configDraft) {
  // If called with a config draft, test connectivity
  if (configDraft) {
    try {
      await ctx.fetch(configDraft.url + '/api/status');
      return { passed: true };
    } catch (e) {
      return { passed: false, failures: [e.message] };
    }
  }
  // Called without args — run core validation tests
  return { passed: true };
};
```

### registry.json Entry

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does",
  "author": "Your Name",
  "repository": "https://github.com/dksilv4/otix-plugins",
  "path": "plugins/my-plugin",
  "category": "media",
  "tags": ["example"],
  "permissions": ["events:subscribe", "storage:local"]
}
```

## Permissions

| Permission | Description |
|---|---|
| `api:proxy` | Read/write Otix data via authenticated API |
| `network:external` | Connect to external services (Radarr, Sonarr, etc.) |
| `events:subscribe` | Listen for Otix events (ratings, watched, list changes) |
| `storage:local` | Store data in local SQLite database |
| `ui:settings` | Register a settings page |
| `notifications` | Send desktop notifications |
| `worker:compute` | Contribute compute as a worker |

## Registry URL

```
https://raw.githubusercontent.com/dksilv4/otix-plugins/main/registry.json
```
