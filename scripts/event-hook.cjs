/**
 * event-hook.cjs - Universal hook event forwarder (CommonJS)
 * Receives tool call data from stdin (JSON), POSTs to worker service.
 * On 'pre' events, reads the transcript to extract Claude's latest thinking text.
 * Arg: "pre" or "post" passed via process.argv[2]
 */
const { request } = require('http');
const { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const phase = process.argv[2] || 'post';
const PORT = parseInt(process.env.AGENT_MONITOR_PORT || '37800');
const DATA_DIR = join(homedir(), '.monikhao');
const LOG_FILE = join(DATA_DIR, 'debug.log');

function debugLog(msg) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/**
 * Read the last assistant entry from the transcript JSONL.
 * Returns { thinking, model } — only reads the tail (last 8KB) for speed.
 */
function extractTranscriptInfo(transcriptPath) {
  const result = { thinking: null, model: null };
  if (!transcriptPath || !existsSync(transcriptPath)) return result;
  try {
    const stat = statSync(transcriptPath);
    const tailSize = Math.min(stat.size, 8192);
    const fd = require('fs').openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(tailSize);
    require('fs').readSync(fd, buf, 0, tailSize, stat.size - tailSize);
    require('fs').closeSync(fd);

    const tail = buf.toString('utf8');
    const lines = tail.split('\n').filter(Boolean);
    if (tailSize < stat.size) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message) {
          if (!result.model && entry.message.model) {
            result.model = entry.message.model;
          }
          if (!result.thinking && entry.message.content) {
            const thoughts = entry.message.content
              .filter(c => c.type === 'thinking' && c.thinking)
              .map(c => c.thinking);
            if (thoughts.length) result.thinking = thoughts[thoughts.length - 1].slice(0, 300);
          }
          if (result.thinking && result.model) break;
        }
      } catch {}
    }
  } catch {}
  return result;
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

  debugLog(`event-hook ${phase}: tool=${data.tool_name || 'none'} session=${data.session_id || 'none'}`);

  // On 'pre' events, extract thinking text + model from the transcript
  let thinking = null;
  let model = null;
  if (phase === 'pre' && data.transcript_path) {
    const info = extractTranscriptInfo(data.transcript_path);
    thinking = info.thinking;
    model = info.model;
  }

  const payload = JSON.stringify({
    phase,
    timestamp: Date.now(),
    session_id: data.session_id || null,
    source: 'claudecode',
    tool_name: data.tool_name || null,
    tool_input: data.tool_input || null,
    tool_response: phase === 'post' ? (data.tool_response || null) : null,
    thinking: thinking,
    model: model,
    cwd: data.cwd || null
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
