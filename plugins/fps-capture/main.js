/**
 * FPS Capture Plugin
 *
 * Captures frame timing data using Intel PresentMon, computes FPS
 * statistics, and persists play sessions to disk.
 *
 * Runs in a Node.js worker thread — has full access to child_process,
 * fs, path, and electron APIs.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createInterface } = require('readline');
// electron may not be available in worker threads — fall back gracefully
let app;
try { app = require('electron').app; } catch { app = null; }

// ── Constants ──────────────────────────────────────────────────────

const MAX_FRAMES = 36000; // ~10 min at 60 fps
const MAX_SESSIONS = 100;
const FPS_POLL_MS = 500;
const WINDOW_MS = 1000; // sliding window for live FPS

const INTERFERING_SESSIONS = [
  'PresentMon', 'OtixCapture', 'FPS_Capture', 'GraphicsPerfMonitorSession',
];
const GAMING_SERVICES = ['GamingServices', 'GamingServicesNet'];

// ── PresentMon discovery ───────────────────────────────────────────

let _presentMonPath = undefined;

function findPresentMon() {
  if (_presentMonPath !== undefined) return _presentMonPath;

  const paths = [];

  // Downloaded location (userData)
  try {
    const userData = app ? app.getPath('userData') : process.cwd();
    paths.push(path.join(userData, 'PresentMon', 'PresentMon.exe'));
  } catch {}

  // Bundled with packaged app
  try {
    paths.push(path.join(process.resourcesPath, 'bin', 'PresentMon.exe'));
  } catch {}

  // System / local installs
  paths.push(
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'PresentMon', 'PresentMon.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'PresentMon', 'PresentMon.exe'),
  );

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) { _presentMonPath = p; return p; }
    } catch {}
  }

  // Try `where` on Windows
  if (process.platform === 'win32') {
    try {
      const result = execSync('where PresentMon 2>nul', { encoding: 'utf-8', timeout: 3000 });
      const first = result.trim().split('\n')[0]?.trim();
      if (first) { _presentMonPath = first; return first; }
    } catch {}
  }

  _presentMonPath = null;
  return null;
}

function isPresentMonAvailable() {
  return findPresentMon() !== null;
}

// ── ETW session cleanup ───────────────────────────────────────────

function cleanupEtwSessions() {
  for (const name of GAMING_SERVICES) {
    try { execSync(`sc stop "${name}" 2>nul`, { timeout: 5000, windowsHide: true }); } catch {}
  }
  for (const name of INTERFERING_SESSIONS) {
    try { execSync(`logman stop "${name}" -ets 2>nul`, { timeout: 3000, windowsHide: true }); } catch {}
  }
}

function restoreGamingServices() {
  for (const name of GAMING_SERVICES) {
    try { execSync(`sc start "${name}" 2>nul`, { timeout: 5000, windowsHide: true }); } catch {}
  }
}

// ── CSV parsing ────────────────────────────────────────────────────

function parseCsvHeader(line) {
  const cols = line.trim().split(',');
  const map = new Map();
  for (let i = 0; i < cols.length; i++) {
    map.set(cols[i].trim().toLowerCase(), i);
  }
  return map;
}

function parseFrameTime(line, colIndex, targetPid) {
  const cols = line.trim().split(',');

  if (targetPid !== undefined) {
    const pidIdx = colIndex.get('processid');
    if (pidIdx === undefined) return null;
    if (parseInt(cols[pidIdx], 10) !== targetPid) return null;
  }

  const msIdx = colIndex.get('msbetweenpresents');
  if (msIdx === undefined) return null;

  const val = parseFloat(cols[msIdx]);
  return Number.isFinite(val) && val > 0 && val <= 500 ? val : null;
}

// ── Stats computation ──────────────────────────────────────────────

function computeStats(frameTimesMs) {
  if (frameTimesMs.length === 0) {
    return { avgFps: 0, onePercentLow: 0, zeroPointOnePercentLow: 0, maxFps: 0, minFps: 0, totalFrames: 0, captureDurationMs: 0 };
  }

  const fpsValues = frameTimesMs.map(ms => 1000 / ms).sort((a, b) => a - b);
  const n = fpsValues.length;
  const avgFps = fpsValues.reduce((s, v) => s + v, 0) / n;
  const totalMs = frameTimesMs.reduce((s, v) => s + v, 0);

  const onePctCount = Math.max(1, Math.floor(n * 0.01));
  const onePctSlice = fpsValues.slice(0, onePctCount);
  const onePercentLow = onePctSlice.reduce((s, v) => s + v, 0) / onePctSlice.length;

  const dotOnePctCount = Math.max(1, Math.floor(n * 0.001));
  const dotOnePctSlice = fpsValues.slice(0, dotOnePctCount);
  const zeroPointOnePercentLow = dotOnePctSlice.reduce((s, v) => s + v, 0) / dotOnePctSlice.length;

  return {
    avgFps: Math.round(avgFps * 10) / 10,
    onePercentLow: Math.round(onePercentLow * 10) / 10,
    zeroPointOnePercentLow: Math.round(zeroPointOnePercentLow * 10) / 10,
    maxFps: Math.round(fpsValues[n - 1] * 10) / 10,
    minFps: Math.round(fpsValues[0] * 10) / 10,
    totalFrames: n,
    captureDurationMs: Math.round(totalMs),
  };
}

// ── Capture lifecycle ──────────────────────────────────────────────

let activeSession = null;
let pollTimer = null;
let sessionsPath = '';

function getLiveFps() {
  if (!activeSession) return null;

  const { frameTimesMs, startWallMs, gameId } = activeSession;
  const elapsed = Date.now() - startWallMs;

  let windowSum = 0;
  let windowCount = 0;
  for (let i = frameTimesMs.length - 1; i >= 0; i--) {
    windowSum += frameTimesMs[i];
    windowCount++;
    if (windowSum >= WINDOW_MS) break;
  }

  if (windowCount === 0) return null;

  const fps = windowSum > 0 ? Math.round((windowCount / windowSum) * 10000) / 10 : 0;

  return {
    currentFps: fps,
    frameCount: frameTimesMs.length,
    captureDurationMs: elapsed,
    gameId,
  };
}

function startCapture(pid, gameId, processName, hostEmit) {
  const exePath = findPresentMon();
  if (!exePath) return false;

  if (activeSession) stopCapture(hostEmit);

  const frameTimesMs = [];

  const args = [
    '--output_stdout', '--stop_existing_session', '--no_console_stats',
    '--process_id', String(pid),
  ];
  if (processName) args.push('--process_name', processName);

  cleanupEtwSessions();

  const child = spawn(exePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  let headerParsed = false;
  let colIndex = new Map();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const cleaned = line.replace(/\0/g, '');
    const trimmed = cleaned.trim();
    if (!trimmed) return;

    if (!headerParsed) {
      if (trimmed.startsWith('Application') || trimmed.startsWith('ProcessID')) {
        colIndex = new Map(cleaned.split(',').map((c, i) => [c.trim().toLowerCase(), i]));
        headerParsed = true;
      }
      return;
    }

    const ft = parseFrameTime(trimmed, colIndex, pid);
    if (ft !== null) {
      frameTimesMs.push(ft);
      if (frameTimesMs.length > MAX_FRAMES) {
        frameTimesMs.splice(0, frameTimesMs.length - MAX_FRAMES);
      }
    }
  });

  child.on('exit', (code) => {
    rl.close();
    if (code === 6 && gameId) {
      try { hostEmit('fps:permission-needed', { pid, gameId }); } catch {}
    }
    activeSession = null;
    restoreGamingServices();
  });

  if (child.stderr) {
    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg && !msg.includes('warning:')) {
        console.log('[PresentMon]', msg);
      }
    });
  }

  child.on('error', () => {});

  activeSession = { process: child, frameTimesMs, startWallMs: Date.now(), gameId: gameId || '' };
  return true;
}

function stopCapture(hostEmit) {
  const frameTimesMs = activeSession ? activeSession.frameTimesMs : null;

  if (activeSession) {
    try { activeSession.process.kill('SIGTERM'); } catch {}
    activeSession = null;
  }

  restoreGamingServices();

  if (frameTimesMs && frameTimesMs.length > 0) {
    return computeStats(frameTimesMs);
  }
  return null;
}

function isCapturing() {
  return activeSession !== null;
}

// ── Session persistence ────────────────────────────────────────────

function saveSession(session, maxSessions) {
  try {
    const dir = path.dirname(sessionsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let sessions = [];
    try { sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8')); } catch {}

    sessions.push(session);
    if (sessions.length > (maxSessions || MAX_SESSIONS)) {
      sessions = sessions.slice(-(maxSessions || MAX_SESSIONS));
    }

    fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
  } catch (err) {
    console.error('[fps-capture] Failed to save session:', err.message);
  }
}

function getRecentSessions(limit) {
  try {
    const data = fs.readFileSync(sessionsPath, 'utf-8');
    const sessions = JSON.parse(data);
    return sessions.slice(-Math.min(limit || 20, MAX_SESSIONS));
  } catch {
    return [];
  }
}

function getPlaytimeForGame(gameId) {
  try {
    const data = fs.readFileSync(sessionsPath, 'utf-8');
    const sessions = JSON.parse(data);
    const gameSessions = sessions.filter(s => s.gameId === gameId && s.endTime > s.startTime);
    const totalMs = gameSessions.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);
    const withFps = gameSessions.filter(s => s.fpsStats).sort((a, b) => b.endTime - a.endTime);
    return {
      totalMinutes: Math.round(totalMs / 60000),
      sessionCount: gameSessions.length,
      lastPlayed: gameSessions.length > 0 ? Math.max(...gameSessions.map(s => s.endTime)) : null,
      lastFpsStats: withFps.length > 0 ? withFps[0].fpsStats : null,
    };
  } catch {
    return { totalMinutes: 0, sessionCount: 0, lastPlayed: null, lastFpsStats: null };
  }
}

// ── Permission fix ─────────────────────────────────────────────────

function fixPermissions() {
  try {
    const userData = app ? app.getPath('userData') : process.cwd();
    const psFile = path.join(userData, 'fix-fps-permissions.ps1');
    const psContent =
      'try {\n' +
      '  net localgroup "Performance Log Users" $env:USERNAME /add\n' +
      '  Write-Output "OK"\n' +
      '} catch { Write-Error $_.Exception.Message; exit 1 }\n';
    fs.writeFileSync(psFile, psContent, 'utf-8');
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${psFile}\\"' -WindowStyle Hidden -Wait"`,
      { timeout: 120000 },
    );
    fs.unlinkSync(psFile);
    return { success: true, needRestart: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Event routing ──────────────────────────────────────────────────
// Events from main→worker arrive via pluginModule.onEvent(event, payload).
// ctx.events.on() only sends the subscription request to main; handlers
// are tracked locally and dispatched by onEvent.

const eventHandlers = new Map(); // eventName → Set<handler>

function dispatchEvent(event, payload) {
  const handlers = eventHandlers.get(event);
  if (!handlers) return;
  for (const fn of handlers) {
    try { fn(payload); } catch (e) { console.error('[fps-capture] event handler error:', e); }
  }
}

// ── Plugin entry ───────────────────────────────────────────────────

const entry = function (ctx) {
  const maxSessions = (ctx.config.get('maxSessions') || MAX_SESSIONS);

  // Resolve sessions path (same as GameDetector uses)
  try {
    const userData = app ? app.getPath('userData') : process.cwd();
    sessionsPath = path.join(userData, 'play-sessions.json');
  } catch {
    sessionsPath = path.join(process.cwd(), 'play-sessions.json');
  }

  ctx.logger.info('[fps-capture] Plugin starting, PresentMon:', isPresentMonAvailable() ? 'found' : 'not found');

  // Intercept ctx.events.on to track handlers locally.
  // The real subscription (RPC to main) is handled by the original method.
  const origEventsOn = ctx.events.on.bind(ctx.events);
  ctx.events.on = function (event, handler) {
    if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
    eventHandlers.get(event).add(handler);
    // Fire-and-forget the RPC subscription — unsub promise ignored (plugin lifetime)
    origEventsOn(event).catch(() => {});
  };

  // ── Register handlers (callable via pluginManager.callPluginData) ──

  ctx.handle('isCapturing', async () => isCapturing());
  ctx.handle('isAvailable', async () => isPresentMonAvailable());
  ctx.handle('getLiveFps', async () => getLiveFps());
  ctx.handle('getRecentSessions', async (limit) => getRecentSessions(limit));
  ctx.handle('getPlaytimeForGame', async (gameId) => getPlaytimeForGame(gameId));
  ctx.handle('fixPermissions', async () => fixPermissions());

  // ── Subscribe to game events ─────────────────────────────────────

  ctx.events.on('game:started', (e) => {
    if (!e || !e.pid) return;
    ctx.logger.info(`[fps-capture] game:started — pid ${e.pid}, game ${e.gameId}`);
    if (startCapture(e.pid, e.gameId, e.gameTitle, ctx.host.emit.bind(ctx.host))) {
      // Start polling timer
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        const snapshot = getLiveFps();
        if (snapshot) {
          try { ctx.host.emit('fps:live', snapshot); } catch {}
        }
        if (!isCapturing() && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, FPS_POLL_MS);
    }
  });

  ctx.events.on('game:ended', (e) => {
    if (!e || !e.gameId) return;
    ctx.logger.info(`[fps-capture] game:ended — game ${e.gameId}`);

    // Stop polling
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

    const fpsStats = stopCapture(ctx.host.emit.bind(ctx.host));

    const session = {
      gameId: e.gameId,
      gameTitle: e.gameTitle || '',
      startTime: e.startTime || 0,
      endTime: e.endTime || Date.now(),
      launchedByOtix: e.launchedByOtix || false,
      fpsStats: fpsStats || null,
    };

    saveSession(session, maxSessions);

    try { ctx.host.emit('fps:stats', { gameId: e.gameId, fpsStats: fpsStats || null }); } catch {}
  });

  // ── Cleanup on destroy ───────────────────────────────────────────

  return () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    stopCapture(() => {});
  };
};

// Wire event dispatch — the worker calls pluginModule.onEvent(event, payload)
entry.onEvent = dispatchEvent;

// ── Mandatory test export ─────────────────────────────────────────
// All plugins must export a "test" function returning { passed, failures? }.
// Tests run before the plugin is enabled; a failure prevents enable.

entry.test = async function (_ctx) {
  const failures = [];

  // Test 1: PresentMon discovery doesn't crash
  try {
    isPresentMonAvailable();
  } catch (e) {
    failures.push(`isPresentMonAvailable() crashed: ${e.message}`);
  }

  // Test 2: computeStats with known frame times (5 frames @ 60fps + 1 outlier)
  const testFrames = [16.67, 16.67, 16.67, 33.33, 16.67]; // 4× ~60fps, 1× 30fps
  const stats = computeStats(testFrames);
  if (stats.totalFrames !== 5) failures.push(`totalFrames: expected 5, got ${stats.totalFrames}`);
  if (stats.avgFps < 40 || stats.avgFps > 55) failures.push(`avgFps out of range: ${stats.avgFps} (expected ~47)`);
  if (stats.maxFps < stats.minFps) failures.push(`maxFps (${stats.maxFps}) < minFps (${stats.minFps})`);
  if (stats.onePercentLow <= 0) failures.push(`onePercentLow is ${stats.onePercentLow}, expected >0`);
  if (stats.captureDurationMs <= 0) failures.push(`captureDurationMs is ${stats.captureDurationMs}, expected >0`);

  // Test 3: computeStats with empty array
  const empty = computeStats([]);
  if (empty.totalFrames !== 0 || empty.avgFps !== 0) {
    failures.push('empty frames should return zeros');
  }

  // Test 4: CSV header parsing (PresentMon v2 format, msbetweenpresents at col 9)
  const pmHeader = 'Application,ProcessID,SwapChainAddress,Runtime,PresentFlag,PresentMode,AllowsTearing,PresentDuration,PresentQPCTime,msBetweenPresents,msUntilRenderStart,msGPUActive,msInPresentApi,msUntilDisplayed,msGPUBusy,msCPUWait,msCPUBusy';
  const header = parseCsvHeader(pmHeader);
  if (header.get('msbetweenpresents') !== 9) failures.push('msBetweenPresents column should be 9, got ' + header.get('msbetweenpresents'));
  if (header.get('application') !== 0) failures.push('Application column should be 0');
  if (header.get('processid') !== 1) failures.push('ProcessID column should be 1');

  // Test 5: Frame time parsing with PID filter (16.67ms at col 9)
  const csvLine = 'game.exe,1234,0x1,Hardware,0,0,0,0,0,16.67,0,0,0,0,0,0,0';
  const frameTime = parseFrameTime(csvLine, header, 1234);
  if (frameTime !== 16.67) failures.push(`frameTime: expected 16.67, got ${frameTime}`);

  // Test 6: PID filter rejects wrong PID
  const wrongPid = parseFrameTime(csvLine, header, 9999);
  if (wrongPid !== null) failures.push('PID filter should reject wrong PID');

  // Test 7: isCapturing returns false when no capture active
  if (isCapturing()) failures.push('isCapturing should be false before any capture starts');

  return { passed: failures.length === 0, failures };
};

module.exports = entry;
