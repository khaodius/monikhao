#!/usr/bin/env node
/**
 * kmoni-ctl.cjs — Monikhao worker control CLI
 *
 * Usage:
 *   node kmoni-ctl.cjs on       Start the worker (or confirm already running)
 *   node kmoni-ctl.cjs off      Shut down the worker
 *   node kmoni-ctl.cjs status   Print health + session info
 *   node kmoni-ctl.cjs install  Install npm dependencies
 *
 * Exit codes:  0 = success,  1 = failure
 * Stdout is the human-readable result (safe to display to users).
 */

'use strict'

const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { homedir } = require('node:os')

// ── Config ──────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.AGENT_MONITOR_PORT || '37800')
const HOST = '127.0.0.1'

const DATA_DIR   = join(homedir(), '.monikhao')
const PID_FILE   = join(DATA_DIR, 'worker.pid')
const WORKER_LOG = join(DATA_DIR, 'worker-stderr.log')

// ── Find Monikhao root ─────────────────────────────────────────────────────────

function findRoot() {
  if (process.env.MONIKHAO_ROOT) return process.env.MONIKHAO_ROOT
  if (process.env.MONIKHAO_PATH) return process.env.MONIKHAO_PATH
  var up = resolve(__dirname, '..')
  if (existsSync(join(up, 'scripts', 'worker-service.cjs'))) return up
  var paths = [
    join(homedir(), '.config', 'opencode', 'plugins', 'Monikhao'),
    join(homedir(), 'Desktop', 'Monikhao'),
  ]
  for (var i = 0; i < paths.length; i++) {
    if (existsSync(join(paths[i], 'scripts', 'worker-service.cjs'))) return paths[i]
  }
  return null
}

var ROOT = findRoot()
var WORKER_SCRIPT = ROOT ? join(ROOT, 'scripts', 'worker-service.cjs') : null

// ── HTTP helper ─────────────────────────────────────────────────────────────────

function httpReq(method, path, timeout) {
  timeout = timeout || 3000
  return new Promise(function (res, rej) {
    var req = http.request({ hostname: HOST, port: PORT, path: path, method: method, timeout: timeout }, function (resp) {
      var data = ''
      resp.on('data', function (c) { data += c })
      resp.on('end', function () { res({ status: resp.statusCode, body: data }) })
    })
    req.on('error', rej)
    req.on('timeout', function () { req.destroy(); rej(new Error('timeout')) })
    req.end()
  })
}

function isHealthy() {
  return httpReq('GET', '/api/health').then(function (r) { return r.status === 200 }).catch(function () { return false })
}

function getState() {
  return httpReq('GET', '/api/state').then(function (r) { return JSON.parse(r.body) }).catch(function () { return null })
}

// ── Sleep ───────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

// ── Commands ────────────────────────────────────────────────────────────────────

async function cmdOn() {
  if (await isHealthy()) {
    var st = await getState()
    var sessions = st && st.sessions ? Object.keys(st.sessions).length : 0
    console.log('Monikhao worker is already running on port ' + PORT + ' (' + sessions + ' active session' + (sessions !== 1 ? 's' : '') + ')')
    console.log('Dashboard: http://' + HOST + ':' + PORT)
    return
  }

  if (!WORKER_SCRIPT || !existsSync(WORKER_SCRIPT)) {
    console.error('Worker script not found. Is Monikhao installed?')
    process.exit(1)
  }

  // Kill stale worker
  try {
    if (existsSync(PID_FILE)) {
      var info = JSON.parse(readFileSync(PID_FILE, 'utf8'))
      if (info.pid) { try { process.kill(info.pid) } catch (_) {} }
    }
  } catch (_) {}

  await sleep(300)

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

  var stderrFd
  try { stderrFd = openSync(WORKER_LOG, 'w') } catch (_) { stderrFd = 'ignore' }

  var child = spawn(process.execPath, [WORKER_SCRIPT], {
    detached: true,
    stdio: ['ignore', 'ignore', stderrFd],
    env: Object.assign({}, process.env, { AGENT_MONITOR_PORT: String(PORT), MONIKHAO_ROOT: ROOT }),
    cwd: ROOT,
    windowsHide: true
  })
  child.unref()

  if (child.pid) {
    writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port: PORT, startedAt: new Date().toISOString() }))
  }

  if (typeof stderrFd === 'number') { try { closeSync(stderrFd) } catch (_) {} }

  // Wait for health
  var ok = false
  for (var i = 0; i < 30; i++) {
    await sleep(500)
    if (await isHealthy()) { ok = true; break }
  }

  if (ok) {
    console.log('Monikhao worker started (PID ' + child.pid + ', port ' + PORT + ')')
    console.log('Dashboard: http://' + HOST + ':' + PORT)
  } else {
    console.error('Worker failed to start.')
    try {
      if (existsSync(WORKER_LOG)) {
        var err = readFileSync(WORKER_LOG, 'utf8').trim()
        if (err) console.error('Stderr: ' + err.slice(0, 300))
      }
    } catch (_) {}
    process.exit(1)
  }
}

async function cmdOff() {
  if (!(await isHealthy())) {
    console.log('Monikhao worker is not running.')
    return
  }

  // Determine caller source from --source flag or env
  var mySource = ''
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--source=')) mySource = process.argv[i].split('=')[1]
  }
  if (!mySource) mySource = process.env.KMONI_SOURCE || ''

  // If we know our source, check if the other platform has active sessions
  if (mySource) {
    try {
      var sr = await httpReq('GET', '/api/sessions/sources')
      var data = JSON.parse(sr.body)
      var sources = data.sources || []
      var otherActive = sources.some(function (s) { return s !== mySource && s !== 'unknown' })

      if (otherActive) {
        // Other platform is still using the worker — just disconnect our sessions
        await httpReq('POST', '/api/admin/disconnect?source=' + encodeURIComponent(mySource))
        console.log('Disconnected ' + mySource + ' sessions. Worker still running for other platform.')
        return
      }
    } catch (_) {
      // Could not check sources — fall through to full shutdown
    }
  }

  // No other platform active (or unknown source) — full shutdown
  try {
    await httpReq('POST', '/api/admin/shutdown')
    console.log('Monikhao worker shut down.')
  } catch (e) {
    // Fallback: kill by PID
    try {
      if (existsSync(PID_FILE)) {
        var info = JSON.parse(readFileSync(PID_FILE, 'utf8'))
        if (info.pid) { process.kill(info.pid); console.log('Killed worker PID ' + info.pid); return }
      }
    } catch (_) {}
    console.error('Failed to stop worker: ' + e.message)
    process.exit(1)
  }
}

async function cmdStatus() {
  if (!(await isHealthy())) {
    console.log('Monikhao worker is not running.')
    return
  }

  var st = await getState()
  if (!st) { console.log('Worker healthy but could not fetch state.'); return }

  var sessions = st.sessions ? Object.keys(st.sessions) : []
  console.log('Monikhao worker: running on port ' + PORT)
  console.log('Sessions: ' + sessions.length)
  for (var i = 0; i < sessions.length; i++) {
    var s = st.sessions[sessions[i]]
    var agents = s.agents ? Object.keys(s.agents).length : 0
    console.log('  ' + sessions[i] + ' (' + (s.source || '?') + ', ' + agents + ' agent' + (agents !== 1 ? 's' : '') + ')')
  }
  console.log('Dashboard: http://' + HOST + ':' + PORT)
}

async function cmdInstall() {
  if (!ROOT) {
    console.error('Monikhao folder not found.')
    process.exit(1)
  }

  var isWin = process.platform === 'win32'
  var home = homedir()
  var errors = []

  // ── 1. Install npm dependencies ─────────────────────────────────────────────
  console.log('[1/4] Installing dependencies...')
  var depsOk = false
  if (existsSync(join(ROOT, 'node_modules', 'express', 'package.json'))) {
    console.log('  Dependencies already installed.')
    depsOk = true
  } else {
    try {
      execFileSync('npm', ['install', '--production'], { cwd: ROOT, stdio: 'inherit', timeout: 120000 })
      depsOk = true
    } catch (_) {
      try {
        execFileSync('bun', ['install', '--production'], { cwd: ROOT, stdio: 'inherit', timeout: 120000 })
        depsOk = true
      } catch (_2) {
        errors.push('Failed to install npm dependencies (npm and bun both failed)')
      }
    }
  }

  // ── 2. Set up Claude Code plugin ────────────────────────────────────────────
  console.log('[2/4] Setting up Claude Code...')
  var ccCache = join(home, '.claude', 'plugins', 'cache', 'khaos', 'monikhao', '1.0.0')
  var ccPlugins = join(home, '.claude', 'plugins')

  if (existsSync(join(home, '.claude'))) {
    // Create cache directory structure
    if (!existsSync(ccCache)) {
      mkdirSync(ccCache, { recursive: true })
      mkdirSync(join(ccCache, 'scripts'), { recursive: true })
      mkdirSync(join(ccCache, 'hooks'), { recursive: true })
      mkdirSync(join(ccCache, 'web'), { recursive: true })
      mkdirSync(join(ccCache, '.claude-plugin'), { recursive: true })
    }

    // Copy scripts, hooks, web, config to cache
    var copyItems = [
      { src: 'hooks/hooks.json',     dst: 'hooks/hooks.json' },
      { src: '.claude-plugin/plugin.json', dst: '.claude-plugin/plugin.json' },
      { src: 'config.json',          dst: 'config.json' },
      { src: 'package.json',         dst: 'package.json' },
    ]
    // Copy all scripts
    try {
      var scriptFiles = require('node:fs').readdirSync(join(ROOT, 'scripts'))
      for (var sf = 0; sf < scriptFiles.length; sf++) {
        copyItems.push({ src: 'scripts/' + scriptFiles[sf], dst: 'scripts/' + scriptFiles[sf] })
      }
    } catch (_) {}
    // Copy web files
    try {
      var webFiles = require('node:fs').readdirSync(join(ROOT, 'web'))
      for (var wf = 0; wf < webFiles.length; wf++) {
        copyItems.push({ src: 'web/' + webFiles[wf], dst: 'web/' + webFiles[wf] })
      }
    } catch (_) {}

    var copied = 0
    for (var ci = 0; ci < copyItems.length; ci++) {
      var srcPath = join(ROOT, copyItems[ci].src)
      var dstPath = join(ccCache, copyItems[ci].dst)
      if (existsSync(srcPath)) {
        try {
          var dstDir = require('node:path').dirname(dstPath)
          if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true })
          writeFileSync(dstPath, readFileSync(srcPath))
          copied++
        } catch (_) {}
      }
    }
    console.log('  Copied ' + copied + ' files to Claude Code plugin cache.')

    // Register in installed_plugins.json
    var ipFile = join(ccPlugins, 'installed_plugins.json')
    try {
      var ipData = existsSync(ipFile) ? JSON.parse(readFileSync(ipFile, 'utf8')) : { version: 2, plugins: {} }
      if (!ipData.plugins['monikhao@khaos']) {
        ipData.plugins['monikhao@khaos'] = [{
          scope: 'user',
          installPath: ccCache,
          version: '1.0.0',
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString()
        }]
        writeFileSync(ipFile, JSON.stringify(ipData, null, 2))
        console.log('  Registered monikhao@khaos in installed_plugins.json.')
      } else {
        console.log('  monikhao@khaos already registered.')
      }
    } catch (e) {
      errors.push('Failed to update installed_plugins.json: ' + e.message)
    }

    // Enable in settings.json
    var settingsFile = join(home, '.claude', 'settings.json')
    try {
      var settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}
      if (!settings.enabledPlugins) settings.enabledPlugins = {}
      if (!settings.enabledPlugins['monikhao@khaos']) {
        settings.enabledPlugins['monikhao@khaos'] = true
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
        console.log('  Enabled monikhao@khaos in settings.json.')
      } else {
        console.log('  monikhao@khaos already enabled.')
      }
    } catch (e) {
      errors.push('Failed to update settings.json: ' + e.message)
    }
  } else {
    console.log('  Claude Code not detected (~/.claude missing). Skipped.')
  }

  // ── 3. Set up OpenCode plugin ───────────────────────────────────────────────
  console.log('[3/4] Setting up OpenCode...')
  var ocPlugins = join(home, '.config', 'opencode', 'plugins')

  if (existsSync(join(home, '.config', 'opencode'))) {
    if (!existsSync(ocPlugins)) mkdirSync(ocPlugins, { recursive: true })

    // Copy monikhao.js entry point
    var ocEntry = join(ocPlugins, 'monikhao.js')
    var srcEntry = join(ROOT, 'monikhao.js')
    if (existsSync(srcEntry)) {
      try {
        writeFileSync(ocEntry, readFileSync(srcEntry))
        console.log('  Copied monikhao.js to OpenCode plugins.')
      } catch (e) {
        errors.push('Failed to copy monikhao.js to OpenCode: ' + e.message)
      }
    }

    // Check if Monikhao/ link exists
    var ocLink = join(ocPlugins, 'Monikhao')
    if (existsSync(ocLink)) {
      console.log('  Monikhao/ link already exists in OpenCode plugins.')
    } else {
      console.log('  NOTE: Create a symlink/junction for the Monikhao folder:')
      if (isWin) {
        console.log('    mklink /J "' + ocLink + '" "' + ROOT + '"')
      } else {
        console.log('    ln -s "' + ROOT + '" "' + ocLink + '"')
      }
    }
  } else {
    console.log('  OpenCode not detected (~/.config/opencode missing). Skipped.')
  }

  // ── 4. Create data directory ────────────────────────────────────────────────
  console.log('[4/4] Ensuring data directory...')
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  console.log('  ' + DATA_DIR)

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('')
  if (errors.length > 0) {
    console.log('Completed with ' + errors.length + ' warning(s):')
    for (var ei = 0; ei < errors.length; ei++) {
      console.log('  - ' + errors[ei])
    }
  } else {
    console.log('Installation complete.')
  }
  if (depsOk) {
    console.log('Restart your coding tool to activate. Dashboard: http://' + HOST + ':' + PORT)
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

var cmd = process.argv[2]

switch (cmd) {
  case 'on':      cmdOn(); break
  case 'off':     cmdOff(); break
  case 'status':  cmdStatus(); break
  case 'install': cmdInstall(); break
  default:
    console.log('Usage: kmoni-ctl [on|off|status|install]')
    process.exit(cmd ? 1 : 0)
}
