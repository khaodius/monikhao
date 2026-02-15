/**
 * monikhao.js - OpenCode bootstrap for Monikhao (Agent Monitor)
 *
 * Place this file alongside the Monikhao/ folder in ~/.config/opencode/plugins/
 *
 *   ~/.config/opencode/plugins/
 *     monikhao.js        <- this file (auto-loaded by OpenCode)
 *     Monikhao/          <- project folder (scripts, web, config, etc.)
 *
 * On first load this bootstrap:
 *   1. Discovers the Monikhao/ folder (sibling, env var, or standard paths)
 *   2. Creates the /kmoni-install command if it doesn't exist
 *   3. If dependencies are installed  -> activates the full plugin
 *   4. If dependencies are missing    -> stays dormant (run /kmoni-install)
 *
 * Override port:  AGENT_MONITOR_PORT  (default 37800)
 * Override root:  MONIKHAO_PATH       (absolute path to Monikhao folder)
 */

import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, writeFileSync, readFileSync,
  appendFileSync, unlinkSync, openSync, closeSync
} from 'node:fs'
import { homedir, platform } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── Discover Monikhao root ────────────────────────────────────────────────────

const __dirname_ = dirname(fileURLToPath(import.meta.url))

function findRoot() {
  const candidates = [
    // 1. Explicit env override
    process.env.MONIKHAO_PATH,
    // 2. Sibling to this file  (plugins/Monikhao)
    resolve(__dirname_, 'Monikhao'),
    // 3. One level up            (~/.config/opencode/Monikhao)
    resolve(__dirname_, '..', 'Monikhao'),
    // 4. XDG standard
    join(homedir(), '.config', 'opencode', 'plugins', 'Monikhao'),
    join(homedir(), '.config', 'opencode', 'Monikhao'),
  ]
  for (const p of candidates) {
    if (p && existsSync(join(p, 'scripts', 'worker-service.cjs'))) return p
  }
  return null
}

const PLUGIN_ROOT = findRoot()

// ─── Constants ──────────────────────────────────────────────────────────────────

const PORT  = parseInt(process.env.AGENT_MONITOR_PORT || '37800')
const HOST  = '127.0.0.1'
const BASE  = `http://${HOST}:${PORT}`

const DATA_DIR   = join(homedir(), '.monikhao')
const PID_FILE   = join(DATA_DIR, 'worker.pid')
const LOCK_FILE  = join(DATA_DIR, 'spawn.lock')
const LOG_FILE   = join(DATA_DIR, 'debug.log')
const WORKER_LOG = join(DATA_DIR, 'worker-stderr.log')

const WORKER_SCRIPT = PLUGIN_ROOT ? join(PLUGIN_ROOT, 'scripts', 'worker-service.cjs') : null

let sessionId = null
let _sessionStartSent = false   // Guard against multiple plugin activations sending duplicate session_start
let _exitHandlersRegistered = false

// ─── Logging ────────────────────────────────────────────────────────────────────

function debugLog(msg) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [monikhao] ${msg}\n`)
  } catch {}
}

// ─── /kmoni-* commands bootstrap ─────────────────────────────────────────────

function ensureCommands() {
  try {
    const cmdDir = join(homedir(), '.config', 'opencode', 'commands')
    if (!existsSync(cmdDir)) mkdirSync(cmdDir, { recursive: true })

    const root = PLUGIN_ROOT
      ? PLUGIN_ROOT.replace(/\\/g, '/')
      : '~/.config/opencode/plugins/Monikhao'

    // /kmoni-install
    const installFile = join(cmdDir, 'kmoni-install.md')
    if (!existsSync(installFile)) {
      writeFileSync(installFile, [
        '---',
        'description: Install Monikhao agent monitor dependencies',
        '---',
        '',
        'Install the Monikhao agent monitor plugin. Follow these steps exactly:',
        '',
        `1. The Monikhao project directory is at: ${root}`,
        '   Verify it exists.',
        '',
        '2. Install Node.js dependencies:',
        '   ```bash',
        `   cd "${root}" && npm install --production`,
        '   ```',
        '   If npm is unavailable, try:',
        '   ```bash',
        `   cd "${root}" && bun install --production`,
        '   ```',
        '',
        '3. Verify that express and ws are installed:',
        '   ```bash',
        `   ls "${root}/node_modules/express/package.json"`,
        '   ```',
        '',
        '4. Tell the user:',
        '   - Dependencies are installed.',
        '   - Restart OpenCode for the agent monitor to activate.',
        '   - After restart, the 3D dashboard will be live at http://127.0.0.1:37800',
        '',
      ].join('\n'))
      debugLog('Created /kmoni-install command')
    }

    // /kmoni-on
    const onFile = join(cmdDir, 'kmoni-on.md')
    if (!existsSync(onFile)) {
      writeFileSync(onFile, [
        '---',
        'description: Start the Monikhao agent monitor worker',
        '---',
        '',
        'Start the Monikhao agent monitor worker service. Follow these steps:',
        '',
        '1. First check if it\'s already running:',
        '   ```bash',
        '   curl -s http://127.0.0.1:37800/api/health',
        '   ```',
        '   If it returns `{"status":"ok"...}`, tell the user the worker is already running and the dashboard is at http://127.0.0.1:37800',
        '',
        '2. If the health check fails, start the worker as a detached background process:',
        '   ```bash',
        `   nohup node "${root}/scripts/worker-service.cjs" > /dev/null 2>&1 &`,
        '   ```',
        '   On Windows:',
        '   ```bash',
        `   start /b node "${root}/scripts/worker-service.cjs"`,
        '   ```',
        '',
        '3. Wait 2 seconds, then verify it started:',
        '   ```bash',
        '   curl -s http://127.0.0.1:37800/api/health',
        '   ```',
        '',
        '4. Tell the user the dashboard is live at http://127.0.0.1:37800',
        '',
      ].join('\n'))
      debugLog('Created /kmoni-on command')
    }

    // /kmoni-off
    const offFile = join(cmdDir, 'kmoni-off.md')
    if (!existsSync(offFile)) {
      writeFileSync(offFile, [
        '---',
        'description: Stop the Monikhao agent monitor worker',
        '---',
        '',
        'Stop the Monikhao agent monitor worker service. Follow these steps:',
        '',
        '1. Send the shutdown command:',
        '   ```bash',
        '   curl -s -X POST http://127.0.0.1:37800/api/admin/shutdown',
        '   ```',
        '   If it returns `{"status":"shutting_down"}`, the worker has been stopped.',
        '',
        '2. If the curl fails (connection refused), the worker is already stopped. Tell the user.',
        '',
        '3. Tell the user the Monikhao worker has been stopped. It will auto-start again on next OpenCode or Claude Code session, or they can run /kmoni-on to start it manually.',
        '',
      ].join('\n'))
      debugLog('Created /kmoni-off command')
    }
  } catch (e) {
    debugLog(`Failed to create commands: ${e.message}`)
  }
}

// ─── Dependency check ───────────────────────────────────────────────────────────

function depsInstalled() {
  if (!PLUGIN_ROOT) return false
  return existsSync(join(PLUGIN_ROOT, 'node_modules', 'express'))
    && existsSync(join(PLUGIN_ROOT, 'node_modules', 'ws'))
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────────

async function postEvent(payload) {
  try {
    await fetch(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000)
    })
  } catch {}
}

async function isHealthy() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch { return false }
}

// ─── Worker lifecycle ───────────────────────────────────────────────────────────

function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
      if (Date.now() - lockData.ts < 20000) return false
    }
    writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid }))
    return true
  } catch { return false }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE) } catch {}
}

function killStaleWorker() {
  try {
    if (!existsSync(PID_FILE)) return
    const info = JSON.parse(readFileSync(PID_FILE, 'utf8'))
    if (info.pid) {
      try { process.kill(info.pid, 0); process.kill(info.pid) } catch {}
    }
  } catch {}
}

async function waitForHealth(ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await isHealthy()) return true
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

async function ensureWorker() {
  if (await isHealthy()) { debugLog('Worker already healthy'); return true }
  if (!WORKER_SCRIPT || !existsSync(WORKER_SCRIPT)) {
    debugLog(`Worker script not found: ${WORKER_SCRIPT}`)
    return false
  }

  if (!acquireLock()) { debugLog('Spawn lock held'); return await waitForHealth(20000) }

  try {
    if (await isHealthy()) return true

    killStaleWorker()
    await new Promise(r => setTimeout(r, 500))

    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

    let stderrFd
    try { stderrFd = openSync(WORKER_LOG, 'w') } catch { stderrFd = 'ignore' }

    // Use the current runtime (node or bun — both handle .cjs)
    // Pass MONIKHAO_ROOT so the worker resolves config/web from the right place
    // regardless of which platform spawned it
    const runtime = process.execPath
    const child = spawn(runtime, [WORKER_SCRIPT], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      env: { ...process.env, AGENT_MONITOR_PORT: String(PORT), MONIKHAO_ROOT: PLUGIN_ROOT },
      cwd: PLUGIN_ROOT,
      windowsHide: true
    })
    child.unref()

    if (child.pid) {
      writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port: PORT, startedAt: new Date().toISOString() }))
      debugLog(`Spawned worker PID ${child.pid} via ${runtime}`)
    }

    if (typeof stderrFd === 'number') { try { closeSync(stderrFd) } catch {} }

    const ok = await waitForHealth(15000)
    debugLog(`Health after spawn: ${ok}`)

    if (!ok) {
      try {
        if (existsSync(WORKER_LOG)) {
          const err = readFileSync(WORKER_LOG, 'utf8').trim()
          if (err) debugLog(`Worker stderr: ${err.slice(0, 500)}`)
        }
      } catch {}
    }
    return ok
  } finally { releaseLock() }
}

// ─── Session helpers ────────────────────────────────────────────────────────────

function getSessionId() {
  if (!sessionId) sessionId = `oc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return sessionId
}

function makeEvent(phase, extra) {
  return {
    phase, timestamp: Date.now(), session_id: getSessionId(),
    source: 'opencode',
    tool_name: null, tool_input: null, tool_response: null,
    ...extra
  }
}

// ─── Plugin Export ──────────────────────────────────────────────────────────────

/** @type {import("@opencode-ai/plugin").Plugin} */
export const Monikhao = async (ctx) => {
  // Always create /kmoni-* commands so they're available
  ensureCommands()

  // If Monikhao folder wasn't found at all, bail gracefully
  if (!PLUGIN_ROOT) {
    debugLog('Monikhao folder not found. Place it alongside monikhao.js in the plugins directory.')
    return {}
  }

  // If dependencies aren't installed, stay dormant
  if (!depsInstalled()) {
    debugLog('Dependencies missing. Run /kmoni-install to complete setup.')
    return {}
  }

  // ── Full plugin mode ────────────────────────────────────────────────────────
  debugLog(`Plugin active (root: ${PLUGIN_ROOT}, dir: ${ctx.directory || 'unknown'})`)

  const workerReady = await ensureWorker()
  if (workerReady) {
    debugLog(`Worker ready, waiting for session.created event to register session`)
  } else {
    debugLog('Worker not available — events will queue when it comes online')
  }

  // ── Send session_end when the process exits (Ctrl+C, close terminal, etc.) ──
  function sendSessionEndSync() {
    try {
      const payload = JSON.stringify(makeEvent('session_end'))
      // Synchronous HTTP via Bun/Node child_process to ensure it fires before exit
      const { execSync } = require('node:child_process')
      const cmd = `node -e "const http=require('http');const d=${JSON.stringify(payload)};const r=http.request({hostname:'${HOST}',port:${PORT},path:'/api/events',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)},timeout:2000},()=>process.exit(0));r.on('error',()=>process.exit(0));r.write(d);r.end()"`
      execSync(cmd, { timeout: 3000, stdio: 'ignore', windowsHide: true })
      debugLog(`Session end sent on exit: ${getSessionId()}`)
    } catch (e) {
      debugLog(`Failed to send session_end on exit: ${e.message}`)
    }
  }

  if (!_exitHandlersRegistered) {
    _exitHandlersRegistered = true
    const exitHandler = () => { sendSessionEndSync(); process.exit() }
    const beforeExitHandler = () => { sendSessionEndSync() }

    process.on('SIGINT', exitHandler)
    process.on('SIGTERM', exitHandler)
    process.on('beforeExit', beforeExitHandler)
  }

  return {
    'tool.execute.before': async (input, output) => {
      await postEvent(makeEvent('pre', {
        tool_name: input.tool || null,
        tool_input: output?.args || null,
        cwd: ctx.directory || null
      }))
    },

    'tool.execute.after': async (input) => {
      await postEvent(makeEvent('post', {
        tool_name: input.tool || null,
        tool_input: input.args || null,
        tool_response: input.result ?? null,
        cwd: ctx.directory || null
      }))
    },

    event: async ({ event }) => {
      const type = event.type

      if (type === 'session.created') {
        if (_sessionStartSent) {
          debugLog(`Skipping duplicate session.created (already sent for ${sessionId})`)
          return
        }
        sessionId = event.properties?.id || getSessionId()
        _sessionStartSent = true
        await ensureWorker()
        await postEvent(makeEvent('session_start'))
        debugLog(`Session started: ${sessionId}`)
      }

      if (type === 'session.deleted' || type === 'session.error') {
        await postEvent(makeEvent('session_end'))
        sessionId = null
        _sessionStartSent = false
      }

      if (type === 'session.idle') {
        await postEvent(makeEvent('notification', { message: '[session idle]' }))
      }

      if (type === 'session.compacted') {
        await postEvent(makeEvent('notification', { message: '[context compacted]' }))
      }

      if (type === 'file.edited') {
        const fp = event.properties?.path || event.properties?.filePath
        if (fp) await postEvent(makeEvent('notification', { message: `[file.edited] ${fp}` }))
      }

      if (type === 'message.updated' && event.properties?.role === 'assistant') {
        const text = event.properties?.content
        if (text && typeof text === 'string') {
          await postEvent(makeEvent('notification', { message: text.slice(0, 200) }))
        }
      }
    }
  }
}
