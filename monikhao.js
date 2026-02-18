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

import { spawn, execFileSync } from 'node:child_process'
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
let detectedModel = null
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

    const ctl = PLUGIN_ROOT
      ? join(PLUGIN_ROOT, 'scripts', 'kmoni-ctl.cjs').replace(/\\/g, '/')
      : '~/.config/opencode/plugins/Monikhao/scripts/kmoni-ctl.cjs'

    // Minimal single-command .md files — just call kmoni-ctl.cjs directly.
    // The tui.command.execute hook handles these programmatically first;
    // these .md files are a fallback if the hook doesn't fire.
    const cmds = {
      'kmoni-on':      { desc: 'Start the Monikhao worker',              action: 'on' },
      'kmoni-off':     { desc: 'Stop the Monikhao worker',               action: 'off' },
      'kmoni-install': { desc: 'Install Monikhao dependencies',          action: 'install' },
      'kmoni-status':  { desc: 'Show Monikhao worker status',            action: 'status' },
    }

    for (const [name, cfg] of Object.entries(cmds)) {
      writeFileSync(join(cmdDir, name + '.md'), [
        '---',
        `description: ${cfg.desc}`,
        '---',
        '',
        `Run this exact command. Do not explain, modify, or add steps. Just run it and show the raw output:`,
        '```bash',
        `node "${ctl}" ${cfg.action}`,
        '```',
      ].join('\n'))
    }
    debugLog('Wrote /kmoni-* command files')
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
    source: 'opencode', model: detectedModel,
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

  // ── Model detection via client API ─────────────────────────────────────────
  async function detectModel() {
    try {
      if (!ctx.client) return
      const sessions = await ctx.client.session.list()
      if (sessions?.data) {
        for (const s of Object.values(sessions.data)) {
          const m = s.model || s.modelID || s.config?.model
          if (m) {
            const str = typeof m === 'object' ? (m.modelID || m.id || null) : String(m)
            if (str && str !== 'null') { detectedModel = str; debugLog(`Model from session API: ${str}`); return }
          }
        }
      }
    } catch (e) { debugLog(`Model detection failed: ${e.message}`) }
  }

  // ── Full plugin mode ────────────────────────────────────────────────────────
  debugLog(`Plugin active (root: ${PLUGIN_ROOT}, dir: ${ctx.directory || 'unknown'})`)

  const workerReady = await ensureWorker()
  await detectModel()
  if (workerReady && !_sessionStartSent) {
    _sessionStartSent = true
    await postEvent(makeEvent('session_start'))
    debugLog(`Session started on activation: ${getSessionId()}`)
  } else if (!workerReady) {
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
    // ── Direct command execution (bypasses AI) ────────────────────────────────
    'tui.command.execute': async (input) => {
      const name = (input?.command || input?.name || '').replace(/^\//, '')
      const ctl = join(PLUGIN_ROOT, 'scripts', 'kmoni-ctl.cjs')

      if (name === 'kmoni-on' || name === 'kmoni-off' || name === 'kmoni-install' || name === 'kmoni-status') {
        const action = name.replace('kmoni-', '')
        const args = [ctl, action]
        if (action === 'off') args.push('--source=opencode')
        try {
          const out = execFileSync(process.execPath, args, {
            timeout: 30000,
            encoding: 'utf8',
            env: { ...process.env, MONIKHAO_ROOT: PLUGIN_ROOT }
          })
          debugLog(`/${name} executed: ${out.trim()}`)
          return { output: out.trim(), handled: true }
        } catch (e) {
          const msg = e.stderr || e.stdout || e.message
          debugLog(`/${name} failed: ${msg}`)
          return { output: 'Error: ' + msg, handled: true }
        }
      }
    },

    // ── Model detection via chat.params hook ──────────────────────────────────
    'chat.params': async (input, output) => {
      if (input?.model) {
        const m = input.model
        const newModel = typeof m === 'object'
          ? (m.modelID || m.id || m.model || m.name || JSON.stringify(m))
          : String(m)
        if (newModel && newModel !== detectedModel) {
          const prev = detectedModel
          detectedModel = newModel
          debugLog(`Model ${prev ? 'changed' : 'detected'}: ${detectedModel} (provider: ${input.provider || 'unknown'})`)
          if (_sessionStartSent) {
            await postEvent(makeEvent('session_start'))
          }
        }
      }
    },

    'tool.execute.before': async (input, output) => {
      // Fallback: pick up model from tool metadata if chat.params didn't fire
      const m = input?.model || input?.modelID || output?.model
      if (m) {
        const newModel = typeof m === 'object' ? (m.modelID || m.id || null) : String(m)
        if (newModel && newModel !== detectedModel) {
          detectedModel = newModel
          debugLog(`Model from tool input: ${detectedModel}`)
        }
      }
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
      const props = event.properties || {}

      // Extract model from any event properties
      const evtModel = props.model || props.modelID || props.config?.model
      if (evtModel && !detectedModel) {
        detectedModel = typeof evtModel === 'object' ? (evtModel.modelID || evtModel.id || null) : String(evtModel)
        if (detectedModel) debugLog(`Model from event ${type}: ${detectedModel}`)
      }

      if (type === 'session.created') {
        const newId = props.id
        if (newId && newId !== sessionId) {
          sessionId = newId
          debugLog(`Session ID updated to: ${sessionId}`)
        }
        await detectModel()
        // If session_start wasn't sent during activation (worker was down), send it now
        if (!_sessionStartSent) {
          _sessionStartSent = true
          await ensureWorker()
          await postEvent(makeEvent('session_start'))
          debugLog(`Session started (deferred): ${sessionId} (model: ${detectedModel || 'unknown'})`)
        }
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
