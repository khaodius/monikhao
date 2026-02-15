/**
 * session-stop-hook.cjs - Signals session end to worker (CommonJS)
 */
const { request } = require('http');

const PORT = parseInt(process.env.AGENT_MONITOR_PORT || '37800');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let sessionId = null;
  try { const d = input ? JSON.parse(input) : {}; sessionId = d.session_id || null; } catch {}

  const payload = JSON.stringify({ phase: 'session_end', timestamp: Date.now(), session_id: sessionId, source: 'claudecode', tool_name: null, tool_input: null, tool_response: null });
  const req = request({
    hostname: '127.0.0.1', port: PORT, path: '/api/events', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 3000
  }, () => process.exit(0));
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.write(payload);
  req.end();
});
