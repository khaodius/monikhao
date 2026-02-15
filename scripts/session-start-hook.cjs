/**
 * session-start-hook.cjs - Starts the worker service if not running (CommonJS)
 */
const { spawn, spawnSync } = require('child_process');
const { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, unlinkSync } = require('fs');
const { request } = require('http');
const { homedir } = require('os');
const { resolve, join } = require('path');

const PORT = parseInt(process.env.AGENT_MONITOR_PORT || '37800');
const DATA_DIR = join(homedir(), '.monikhao');
const PID_FILE = join(DATA_DIR, 'worker.pid');
const LOCK_FILE = join(DATA_DIR, 'spawn.lock');
const LOG_FILE = join(DATA_DIR, 'debug.log');
const WORKER_LOG = join(DATA_DIR, 'worker-stderr.log');
const PLUGIN_ROOT = resolve(__dirname, '..');

function debugLog(msg) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// Prevent two hooks from spawning simultaneously
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      // Lock is stale if older than 20 seconds
      if (Date.now() - lockData.ts < 20000) {
        debugLog('Spawn lock held by another hook, skipping spawn');
        return false;
      }
    }
    writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid }));
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch {}
}

let stdinData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdinData += chunk; });
process.stdin.on('end', async () => {
  try {
    await main();
  } catch (e) {
    debugLog(`start error: ${e.message}`);
    process.stderr.write(`[monikhao] start error: ${e.message}\n`);
  }
  process.exit(0);
});

async function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  debugLog(`SessionStart hook fired. PLUGIN_ROOT=${PLUGIN_ROOT}`);

  if (await isHealthy()) {
    debugLog('Worker already healthy, posting session_start');
    await postEvent('session_start');
    return;
  }
  debugLog('Worker not healthy, attempting spawn...');

  // Acquire lock to prevent double-spawn from concurrent hooks
  if (!acquireLock()) {
    // Another hook is spawning - just wait for it to finish then post event
    const healthy = await waitForHealth(20000);
    if (healthy) await postEvent('session_start');
    else debugLog('Worker still not healthy after waiting for other spawn');
    return;
  }

  try {
    // Re-check health after acquiring lock (another hook may have started it)
    if (await isHealthy()) {
      debugLog('Worker became healthy while acquiring lock');
      await postEvent('session_start');
      return;
    }

    killStaleWorker();
    // Small delay to let port release after kill
    await new Promise(r => setTimeout(r, 500));

    const workerScript = join(PLUGIN_ROOT, 'scripts', 'worker-service.cjs');
    const nodeExe = process.execPath; // Use exact same node binary running this hook

    // Open stderr log file for the worker
    const { openSync } = require('fs');
    let stderrFd;
    try {
      stderrFd = openSync(WORKER_LOG, 'w');
    } catch {
      stderrFd = 'ignore';
    }

    const child = spawn(nodeExe, [workerScript], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      env: { ...process.env, AGENT_MONITOR_PORT: String(PORT), MONIKHAO_ROOT: PLUGIN_ROOT },
      cwd: PLUGIN_ROOT,
      windowsHide: true
    });
    child.unref();

    if (child.pid) {
      writePidFile(child.pid);
      debugLog(`Spawned worker PID: ${child.pid} (node: ${nodeExe})`);
    } else {
      debugLog('Failed to spawn worker - no PID returned');
    }

    if (typeof stderrFd === 'number') {
      try { require('fs').closeSync(stderrFd); } catch {}
    }

    const healthy = await waitForHealth(15000);
    debugLog(`Health check after spawn: ${healthy}`);
    if (healthy) {
      await postEvent('session_start');
    } else {
      debugLog('Worker failed to start!');
      // Try to read worker stderr log
      try {
        if (existsSync(WORKER_LOG)) {
          const errLog = readFileSync(WORKER_LOG, 'utf8').trim();
          if (errLog) debugLog(`Worker stderr: ${errLog.slice(0, 500)}`);
        }
      } catch {}
    }
  } finally {
    releaseLock();
  }
}

function writePidFile(pid) {
  writeFileSync(PID_FILE, JSON.stringify({ pid, port: PORT, startedAt: new Date().toISOString() }));
}

function killStaleWorker() {
  try {
    if (!existsSync(PID_FILE)) return;
    const info = JSON.parse(readFileSync(PID_FILE, 'utf8'));
    if (info.pid) {
      try {
        process.kill(info.pid, 0); // Check if alive
        debugLog(`Killing stale worker PID: ${info.pid}`);
        process.kill(info.pid);
      } catch {}
    }
  } catch {}
}

function isHealthy() {
  return new Promise(resolve => {
    const req = request({ hostname: '127.0.0.1', port: PORT, path: '/api/health', method: 'GET', timeout: 2000 },
      res => resolve(res.statusCode === 200));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function waitForHealth(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHealthy()) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function postEvent(type) {
  return new Promise(resolve => {
    let sessionId = null;
    try { const p = stdinData ? JSON.parse(stdinData) : {}; sessionId = p.session_id || null; } catch {}
    const payload = JSON.stringify({ phase: type, timestamp: Date.now(), session_id: sessionId, source: 'claudecode', tool_name: null, tool_input: null, tool_response: null });
    const req = request({
      hostname: '127.0.0.1', port: PORT, path: '/api/events', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 3000
    }, () => resolve());
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(payload);
    req.end();
  });
}
