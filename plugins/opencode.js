/**
 * opencode.js - OpenCode plugin adapter for Khaos Monitor
 *
 * Installation:
 *   Copy to .opencode/plugins/ (project) or ~/.config/opencode/plugins/ (global)
 *
 * The worker service auto-spawns on plugin load if not already running.
 * Override port: set AGENT_MONITOR_PORT env var (default: 37800)
 * Override install path: set KHAOS_MONITOR_PATH env var
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = parseInt(process.env.AGENT_MONITOR_PORT || '37800')
const HOST = '127.0.0.1'
const BASE_URL = `http://${HOST}:${PORT}`

const DATA_DIR = join(homedir(), '.agent-monitor')
const PID_FILE = join(DATA_DIR, 'worker.pid')
const LOCK_FILE = join(DATA_DIR, 'spawn.lock')
const LOG_FILE = join(DATA_DIR, 'debug.log')
const WORKER_LOG = join(DATA_DIR, 'worker-stderr.log')

// Resolve plugin root: KHAOS_MONITOR_PATH env > adjacent to this file's parent
const __dirname_ = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = process.env.KHAOS_MONITOR_PATH || resolve(__dirname_, '..')
const WORKER_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'worker-service.cjs')

let sessionId = null

// ─── Logging ────────────────────────────────────────────────────────────────────

function debugLog(msg) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [opencode] ${msg}\n`)
  } catch {}
}

// ─── HTTP helpers (Bun-native fetch) ────────────────────────────────────────────

async function postEvent(payload) {
  try {
    await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000)
    })
  } catch {}
}

async function isHealthy() {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
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
  } catch {
    return false
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE) } catch {}
}

function killStaleWorker() {
  try {
    if (!existsSync(PID_FILE)) return
    const info = JSON.parse(readFileSync(PID_FILE, 'utf8'))
    if (info.pid) {
      try {
        process.kill(info.pid, 0) // alive check
        debugLog(`Killing stale worker PID: ${info.pid}`)
        process.kill(info.pid)
      } catch {}
    }
  } catch {}
}

async function waitForHealth(timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isHealthy()) return true
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

async function ensureWorker() {
  if (await isHealthy()) {
    debugLog('Worker already healthy')
    return true
  }

  debugLog('Worker not healthy, attempting spawn...')
  if (!existsSync(WORKER_SCRIPT)) {
    debugLog(`Worker script not found: ${WORKER_SCRIPT}`)
    return false
  }

  if (!acquireLock()) {
    debugLog('Spawn lock held, waiting for other spawn')
    return await waitForHealth(20000)
  }

  try {
    // Re-check after lock acquisition
    if (await isHealthy()) {
      debugLog('Worker became healthy while acquiring lock')
      return true
    }

    killStaleWorker()
    await new Promise(r => setTimeout(r, 500))

    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

    let stderrFd
    try { stderrFd = openSync(WORKER_LOG, 'w') } catch { stderrFd = 'ignore' }

    const nodeExe = process.execPath
    const child = spawn(nodeExe, [WORKER_SCRIPT], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      env: { ...process.env, AGENT_MONITOR_PORT: String(PORT) },
      cwd: PLUGIN_ROOT,
      windowsHide: true
    })
    child.unref()

    if (child.pid) {
      writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port: PORT, startedAt: new Date().toISOString() }))
      debugLog(`Spawned worker PID: ${child.pid} (runtime: ${nodeExe})`)
    } else {
      debugLog('Failed to spawn worker - no PID returned')
    }

    if (typeof stderrFd === 'number') {
      try { closeSync(stderrFd) } catch {}
    }

    const healthy = await waitForHealth(15000)
    debugLog(`Health check after spawn: ${healthy}`)

    if (!healthy) {
      try {
        if (existsSync(WORKER_LOG)) {
          const errLog = readFileSync(WORKER_LOG, 'utf8').trim()
          if (errLog) debugLog(`Worker stderr: ${errLog.slice(0, 500)}`)
        }
      } catch {}
    }

    return healthy
  } finally {
    releaseLock()
  }
}

// ─── Session ID ─────────────────────────────────────────────────────────────────

function getSessionId() {
  if (!sessionId) sessionId = `oc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return sessionId
}

function makeEvent(phase, extra) {
  return {
    phase,
    timestamp: Date.now(),
    session_id: getSessionId(),
    tool_name: null,
    tool_input: null,
    tool_response: null,
    ...extra
  }
}

// ─── Plugin Export ──────────────────────────────────────────────────────────────

/** @type {import("@opencode-ai/plugin").Plugin} */
export const KhaosMonitor = async (ctx) => {
  // Auto-spawn worker and post session_start on plugin load
  const workerReady = await ensureWorker()
  if (workerReady) {
    await postEvent(makeEvent('session_start'))
    debugLog(`Session started: ${getSessionId()} (dir: ${ctx.directory || 'unknown'})`)
  } else {
    debugLog('Worker not available - events will be posted when worker comes online')
  }

  return {
    // ── Pre-tool ──────────────────────────────────────────────────────────────
    'tool.execute.before': async (input, output) => {
      await postEvent(makeEvent('pre', {
        tool_name: input.tool || null,
        tool_input: output?.args || null,
        cwd: ctx.directory || null
      }))
    },

    // ── Post-tool ─────────────────────────────────────────────────────────────
    'tool.execute.after': async (input) => {
      await postEvent(makeEvent('post', {
        tool_name: input.tool || null,
        tool_input: input.args || null,
        tool_response: input.result ?? null,
        cwd: ctx.directory || null
      }))
    },

    // ── Lifecycle events ──────────────────────────────────────────────────────
    event: async ({ event }) => {
      const type = event.type

      // New session
      if (type === 'session.created') {
        sessionId = event.properties?.id || getSessionId()
        await ensureWorker()
        await postEvent(makeEvent('session_start'))
        debugLog(`Session created: ${sessionId}`)
      }

      // Session ended
      if (type === 'session.deleted' || type === 'session.error') {
        await postEvent(makeEvent('session_end'))
        debugLog(`Session ended: ${getSessionId()} (${type})`)
        sessionId = null
      }

      // Agent finished its turn
      if (type === 'session.idle') {
        await postEvent(makeEvent('notification', {
          message: '[session idle]'
        }))
      }

      // Session compacted
      if (type === 'session.compacted') {
        await postEvent(makeEvent('notification', {
          message: '[context compacted]'
        }))
      }

      // File edited (by the agent)
      if (type === 'file.edited') {
        const filePath = event.properties?.path || event.properties?.filePath
        if (filePath) {
          await postEvent(makeEvent('notification', {
            message: `[file.edited] ${filePath}`
          }))
        }
      }

      // Assistant message updates
      if (type === 'message.updated' && event.properties?.role === 'assistant') {
        const text = event.properties?.content
        if (text && typeof text === 'string') {
          await postEvent(makeEvent('notification', {
            message: text.slice(0, 200)
          }))
        }
      }
    }
  }
}
