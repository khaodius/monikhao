#!/usr/bin/env node
/**
 * prompt-hook.cjs — Claude Code UserPromptSubmit hook
 *
 * Intercepts /kmoni-on, /kmoni-off, /kmoni-status, /kmoni-install
 * and runs them programmatically via kmoni-ctl.cjs.
 *
 * Returns {"decision":"block","message":"..."} to prevent the prompt
 * from reaching the AI. Non-matching prompts pass through with "allow".
 *
 * stdin: {"session_id":"...","user_prompt":"..."}
 * stdout: {"decision":"allow|block","message":"optional"}
 */

'use strict'

const { execFileSync } = require('node:child_process')
const { join, resolve } = require('node:path')

const CTL_MAP = {
  '/kmoni-on':      'on',
  '/kmoni-off':     'off',
  '/kmoni-status':  'status',
  '/kmoni-install': 'install',
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (c) { raw += c })
process.stdin.on('end', function () {
  try {
    var data = JSON.parse(raw)
    var prompt = (data.user_prompt || '').trim()
    var action = CTL_MAP[prompt]

    if (!action) {
      process.stdout.write(JSON.stringify({ decision: 'allow' }))
      return
    }

    // Resolve kmoni-ctl.cjs relative to this script
    var ctl = join(__dirname, 'kmoni-ctl.cjs')

    // Find Monikhao root (same as kmoni-ctl.cjs does internally)
    var root = process.env.MONIKHAO_ROOT
      || process.env.CLAUDE_PLUGIN_ROOT
      || resolve(__dirname, '..')

    var out = ''
    var args = [ctl, action]
    if (action === 'off') args.push('--source=claudecode')
    try {
      out = execFileSync(process.execPath, args, {
        timeout: 30000,
        encoding: 'utf8',
        env: Object.assign({}, process.env, { MONIKHAO_ROOT: root })
      }).trim()
    } catch (e) {
      out = 'Error: ' + (e.stderr || e.stdout || e.message || 'unknown').toString().trim()
    }

    process.stdout.write(JSON.stringify({ decision: 'block', message: out }))
  } catch (e) {
    // Parse error or unexpected failure — allow through
    process.stdout.write(JSON.stringify({ decision: 'allow' }))
  }
})
