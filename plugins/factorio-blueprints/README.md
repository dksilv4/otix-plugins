# Factorio Blueprints

Personal vault and community blueprint sharing for Factorio (Steam app ID: 427520).

## Features

- Store, organize, and manage your personal blueprint collection
- Browse and share blueprints with the community
- Import/export blueprint strings
- Tag and categorize blueprints for easy discovery

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `community_enabled` | boolean | true | Enable community sharing features and browsing |

## Slots

- **media/game/detail/tabs** — Adds a "Blueprints" tab to the Factorio game detail page.

## Services

- **game-feature (blueprint)** — Exposes blueprint storage and retrieval for the Factorio game integration.

## Development

This plugin follows the standard Otix plugin structure:

```
factorio-blueprints/
  manifest.json   — Plugin metadata, permissions, and config schema
  main.js         — Plugin entry point with slotRender, status, test
  README.md       — This file
```

## Building

No build step required. The plugin is loaded dynamically by Otix at runtime.
