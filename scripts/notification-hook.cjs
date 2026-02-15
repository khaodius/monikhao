/**
 * notification-hook.cjs - Forwards Notification events to worker (CommonJS)
 * Captures Claude's response text and sends it to the dashboard.
 */
const { request } = require('http');
const { appendFileSync, existsSync, mkdirSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const PORT = parseInt(process.env.AGENT_MONITOR_PORT || '37800');
const DATA_DIR = join(homedir(), '.monikhao');
const LOG_FILE = join(DATA_DIR, 'debug.log');

function debugLog(msg) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = input ? JSON.parse(input) : {};
  } catch {
    process.exit(0);
  }

  // Log ALL incoming data to debug what Claude Code actually sends
  debugLog(`notification-hook: keys=${Object.keys(data).join(',')} raw=${JSON.stringify(data).slice(0, 300)}`);

  const message = data.message || data.content || data.text || data.notification || '';
  if (!message) { process.exit(0); }

  const payload = JSON.stringify({
    phase: 'notification',
    timestamp: Date.now(),
    session_id: data.session_id || null,
    source: 'claudecode',
    tool_name: null,
    tool_input: null,
    tool_response: null,
    message: typeof message === 'string' ? message.slice(0, 200) : String(message).slice(0, 200)
  });

  const req = request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/events',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 3000
  }, () => process.exit(0));

  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.write(payload);
  req.end();
});
