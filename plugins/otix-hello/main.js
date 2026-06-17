/**
 * Otix Hello World Plugin
 * ========================
 * A local-only demonstration plugin showcasing the Otix desktop plugin system.
 *
 * Demonstrates:
 *   1. Plugin loading and lifecycle
 *   2. Config read/write
 *   3. Local SQLite storage (hello_log table)
 *   4. Event subscription to all available frontend events
 *   5. Desktop notifications (on media:watched)
 *   6. Structured logging
 *   7. Proper cleanup via onDestroy
 *
 * Permissions required (aligned with manifest.json):
 *   - events:subscribe  — for ctx.events.on
 *   - storage:local     — for ctx.db operations
 *   - notifications     — for ctx.notifications.send
 *   - ui:settings       — for ctx.config access
 */

module.exports = function(ctx) {
  ctx.logger.info('Hello World plugin starting', { version: '1.0.0' });

  // ── 1. Read config and log it ──
  const greeting = ctx.config.get('greeting') || 'Hello!';
  ctx.logger.info('Config loaded', { greeting });

  // ── 3. API proxy demo (test connection to backend) ──
  try {
    ctx.api.get('/auth/me').then(function(user) {
      ctx.logger.info('API connected — current user', { username: user?.username });
    }).catch(function(err) {
      ctx.logger.warn('API test failed (login to authenticate)', { error: err.message });
    });
  } catch (err) {
    ctx.logger.warn('API test skipped (permission not granted yet)', { error: err.message });
  }

  // ── 2. Local SQLite storage — create hello_log table ──
  try {
    ctx.db.run(`
      CREATE TABLE IF NOT EXISTS hello_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    ctx.db.run('INSERT INTO hello_log (message) VALUES (?)', [greeting]);
    const count = ctx.db.get('SELECT COUNT(*) as cnt FROM hello_log');
    ctx.logger.info('DB initialized', { rows: count?.cnt ?? 0 });
  } catch (err) {
    ctx.logger.error('DB initialization failed', { error: err.message });
  }

  // ── 3. Subscribe to ALL available events ──
  const subscriptions = [];

  function subscribe(eventName, specificHandler) {
    const unsub = ctx.events.on(eventName, function(payload) {
      try {
        ctx.logger.info('Event received: ' + eventName, payload || {});
        ctx.db.run('INSERT INTO hello_log (message) VALUES (?)', [
          'Event: ' + eventName + ' — ' + JSON.stringify(payload || {})
        ]);
        if (typeof specificHandler === 'function') {
          specificHandler(payload);
        }
      } catch (err) {
        ctx.logger.error('Error handling ' + eventName, { error: err.message });
      }
    });
    subscriptions.push(unsub);
  }

  subscribe('otix:user:login', function() {
    ctx.logger.info('User logged in — plugin active');
  });

  subscribe('otix:user:logout', function() {
    ctx.logger.info('User logged out');
  });

  subscribe('otix:list:item_added', function(payload) {
    ctx.logger.info('List item added', payload);
  });

  subscribe('otix:list:item_removed', function(payload) {
    ctx.logger.info('List item removed', payload);
  });

  subscribe('otix:media:watched', function(payload) {
    ctx.logger.info('User watched media', payload);
    var enableNotifications = ctx.config.get('enable_notifications');
    if (enableNotifications) {
      ctx.notifications.send(
        'Otix Hello Plugin',
        'You watched ' + payload.mediaType + ' #' + payload.mediaId
      );
    }
  });

  subscribe('otix:interaction:rated', function(payload) {
    ctx.logger.info('User rated media', payload);
  });

  // ── 4. Cleanup ──
  ctx.onDestroy(function() {
    ctx.logger.info('Hello World plugin shutting down');

    // Unsubscribe all event handlers
    subscriptions.forEach(function(unsub) {
      unsub();
    });

    // Log final DB count
    try {
      var finalCount = ctx.db.get('SELECT COUNT(*) as cnt FROM hello_log');
      ctx.logger.info('Plugin logged events', { total: finalCount?.cnt ?? 0 });
    } catch (err) {
      ctx.logger.error('Cleanup query failed', { error: err.message });
    }
  });

  ctx.logger.info('Hello World plugin ready');
};
