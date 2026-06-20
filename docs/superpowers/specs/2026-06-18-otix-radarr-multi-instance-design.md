# Radarr Sync Plugin — Multi-Instance Support

## Summary

Upgrade `otix-plugins/plugins/otix-radarr/` from single-instance to multi-instance configuration. Users can manage multiple Radarr servers from one plugin instance.

## Config Schema

- Replace flat `radarr_url`, `radarr_api_key`, `quality_profile_id`, `root_folder_path` with `instances` (list type)
- Each instance item: `name`, `radarr_url`, `radarr_api_key`, `quality_profile_id`, `root_folder_path`
- Add `sync_direction` enum: `otix_to_radarr` (default), `bidirectional`
- Add `poll_interval_minutes` (number, default 15, advanced)
- Backward-compat: detect old flat config, auto-migrate to instances array

## Architecture

- `addToRadarrInstance(tmdbId, title, mediaItemId, instance)` — add to one Radarr
- `addToAllRadarr(tmdbId, title, mediaItemId)` — fan-out to all instances
- `radarrApi(method, path, body)` — HTTP helper using per-instance URL/apiKey
- `ensureList()` — create/find "Radarr Watchlist" in Otix via API
- Event hook: `otix:list:item_added` → lookup media TMDb → addToAllRadarr
- Bidirectional: setInterval polling per instance, Radarr movies → Otix list
- Sync dedup via local SQLite `radarr_sync_log` table (per media_item_id + instance_url)

## Exports

- `module.exports(ctx)` — main entry, lifecycle setup
- `module.exports.status` — total syncs, last sync, per-instance status
- `module.exports.test` — test each instance, aggregate results
- `module.exports.data` — `getLibrary(instanceUrl, apiKey)`, `getAllLibraries()`

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS radarr_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_item_id TEXT NOT NULL,
  tmdb_id INTEGER,
  title TEXT,
  direction TEXT NOT NULL,
  radarr_id INTEGER,
  instance_url TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Cleanup

After porting, remove `extensions/otix-radarr/` from the main Otix app (plugin is installed via marketplace from otix-plugins repo).
