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
module.exports = function(ctx) {
  // Plugin context: ctx.config, ctx.events, ctx.db, ctx.api, ctx.fetch,
  //                 ctx.notifications, ctx.logger, ctx.onDestroy
  
  ctx.logger.info('Plugin started');
  
  ctx.onDestroy(() => {
    ctx.logger.info('Plugin stopped');
  });
};

// Optional: connection test
module.exports.test = async function(ctx, config) {
  return { success: true, message: 'All good!' };
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
