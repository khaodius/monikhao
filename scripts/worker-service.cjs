/**
 * worker-service.cjs - Persistent HTTP + WebSocket server for Monikhao (CommonJS)
 *
 * Shared worker: serves both Claude Code and OpenCode sessions on the same
 * dashboard.  Whichever platform spawns the worker first wins; subsequent
 * spawners will find the health-check passing and skip re-spawning.
 *
 * Root resolution order:
 *   1. MONIKHAO_ROOT env var   (set by the OpenCode bootstrap)
 *   2. resolve(__dirname, '..')  (original behaviour, used by Claude Code hooks)
 */
const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { resolve, join } = require('path');

const PLUGIN_ROOT = process.env.MONIKHAO_ROOT || resolve(__dirname, '..');
const WEB_DIR = join(PLUGIN_ROOT, 'web');
const CONFIG_PATH = join(PLUGIN_ROOT, 'config.json');

const PORT = parseInt(process.env.AGENT_MONITOR_PORT) || 37800;
const HOST = '127.0.0.1';

// ─── Load Config ───────────────────────────────────────────────────────────────
let config = {};
try { config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { config = { port: PORT, host: HOST }; }

// ─── Random Agent Names + Colors ─────────────────────────────────────────────
const AGENT_NAMES = [
  'Nova', 'Cipher', 'Pulse', 'Drift', 'Flux', 'Spark', 'Haze', 'Bolt',
  'Shade', 'Prism', 'Ghost', 'Rune', 'Jinx', 'Nyx', 'Echo', 'Blitz',
  'Vex', 'Onyx', 'Wren', 'Ash', 'Hex', 'Arc', 'Lux', 'Sable',
  'Zephyr', 'Ember', 'Pixel', 'Glitch', 'Dusk', 'Crux', 'Iris', 'Opal',
  'Volt', 'Cobalt', 'Radix', 'Strobe', 'Nebula', 'Apex', 'Flint', 'Sage',
  'Aether', 'Nimbus', 'Vesper', 'Solace', 'Quasar', 'Tempest', 'Wraith', 'Spectre',
  'Homie'
];
const AGENT_COLORS = [
  '#ff6b6b', '#ffa06b', '#ffd93d', '#6bff8d', '#6bffd4', '#6bc5ff',
  '#8b6bff', '#d46bff', '#ff6bba', '#ff4081', '#00e5ff', '#76ff03',
  '#ffab40', '#7c4dff', '#18ffff', '#f4ff81', '#ff80ab', '#b388ff',
  '#84ffff', '#ccff90', '#ffe57f', '#a7ffeb', '#ea80fc', '#80d8ff'
];
const usedNames = new Set();

function pickAgentName() {
  // Try to find an unused name
  const available = AGENT_NAMES.filter(n => !usedNames.has(n));
  const pool = available.length > 0 ? available : AGENT_NAMES;
  const name = pool[Math.floor(Math.random() * pool.length)];
  usedNames.add(name);
  return name;
}

function pickAgentColor() {
  return AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)];
}

const AGENT_SHAPES = ['sphere', 'icosahedron', 'octahedron', 'dodecahedron', 'cube', 'torus', 'cone'];
function pickAgentShape() {
  return AGENT_SHAPES[Math.floor(Math.random() * AGENT_SHAPES.length)];
}

// ─── Source Detection ─────────────────────────────────────────────────────────
// Determine which platform sent the event.  The OpenCode bootstrap sets
// source:'opencode' explicitly; Claude Code hooks don't, so we fall back to
// inspecting the session_id prefix ('oc-' = opencode, anything else = claudecode).
function detectSource(event) {
  if (event.source) return event.source;
  const sid = event.session_id || '';
  if (sid.startsWith('oc-')) return 'opencode';
  return 'claudecode';
}

// ─── Multi-Session State ──────────────────────────────────────────────────────
const sessions = new Map(); // sessionId -> sessionState
let agentIdCounter = 0;

// Carry-over stats from deleted sessions so counters don't reset
const carryOverStats = { toolCalls: 0, filesAccessed: 0, estimatedTokens: 0, linesAdded: 0, linesRemoved: 0, turns: 0, errors: 0 };

const STALE_TIMEOUT = config.staleTimeout || 5 * 60 * 1000; // 5 minutes with no activity = stale

function createSessionState(sessionId, timestamp, source) {
  return {
    session: { id: sessionId, startedAt: timestamp, status: 'active', source: source || 'unknown', model: null },
    agents: [],
    timeline: [],
    files: new Map(),
    stats: { toolCalls: 0, filesAccessed: 0, startedAt: timestamp, estimatedTokens: 0, linesAdded: 0, linesRemoved: 0, turns: 0, errors: 0 },
    pendingToolCalls: new Map(),
    lastActivity: timestamp
  };
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function getOrCreateSession(sessionId, timestamp, source) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createSessionState(sessionId, timestamp, source));
  }
  const ss = sessions.get(sessionId);
  // Backfill source if it was created without one
  if (source && ss.session.source === 'unknown') ss.session.source = source;
  return ss;
}

// Reactivate a session that was auto-ended by the pruner but is getting new activity
function reactivateIfEnded(ss, timestamp) {
  if (ss.session.status === 'ended') {
    ss.session.status = 'active';
    delete ss.session.endedAt;
    // Reactivate the main agent so the orb comes back to life
    const main = ss.agents.find(a => a.type === 'main');
    if (main && main.status === 'completed') {
      main.status = 'active';
      main.completedAt = null;
    }
  }
  ss.lastActivity = timestamp;
}

// Auto-expire stale active sessions + clean up ended sessions
function pruneStaleAndEndedSessions() {
  const now = Date.now();
  const endedCutoff = now - 2 * 60 * 1000; // Remove ended sessions after 2 minutes
  let changed = false;

  for (const [id, s] of sessions) {
    // Remove ended sessions after 2 minutes, but preserve their stats
    if (s.session.status === 'ended' && s.session.endedAt && s.session.endedAt < endedCutoff) {
      carryOverStats.toolCalls += s.stats.toolCalls || 0;
      carryOverStats.filesAccessed += s.stats.filesAccessed || 0;
      carryOverStats.estimatedTokens += s.stats.estimatedTokens || 0;
      carryOverStats.linesAdded += s.stats.linesAdded || 0;
      carryOverStats.linesRemoved += s.stats.linesRemoved || 0;
      carryOverStats.turns += s.stats.turns || 0;
      carryOverStats.errors += s.stats.errors || 0;
      // Free up agent names
      for (const a of s.agents) { if (a.type === 'main') usedNames.delete(a.name); }
      sessions.delete(id);
      changed = true;
      continue;
    }
    // Fast-prune empty sessions (0 tool calls, idle 15s) — e.g. model switch ghosts
    if (s.session.status === 'active' && s.stats.toolCalls === 0 && (now - s.lastActivity) > 15000) {
      for (const a of s.agents) { if (a.type === 'main') usedNames.delete(a.name); }
      sessions.delete(id);
      changed = true;
      continue;
    }
    // Auto-end active sessions with no activity for STALE_TIMEOUT
    if (s.session.status === 'active' && (now - s.lastActivity) > STALE_TIMEOUT) {
      s.session.status = 'ended';
      s.session.endedAt = now;
      for (const agent of s.agents) {
        if (agent.status === 'active') { agent.status = 'completed'; agent.completedAt = now; }
      }
      changed = true;
    }
  }

  if (changed) broadcast({ type: 'state_update', state: getPublicState() });
}
setInterval(pruneStaleAndEndedSessions, 15000);

// ─── Agent Management (per-session) ──────────────────────────────────────────
function getOrCreateMainAgent(ss) {
  let main = ss.agents.find(a => a.type === 'main');
  if (!main) {
    main = {
      id: `agent-${agentIdCounter++}`,
      name: pickAgentName(),
      color: pickAgentColor(),
      shape: pickAgentShape(),
      type: 'main',
      subagentType: null,
      model: null,
      parentId: null,
      sessionId: ss.session.id,
      source: ss.session.source || 'unknown',
      status: 'active',
      spawnedAt: Date.now(),
      completedAt: null,
      toolCalls: [],
      toolCallCount: 0
    };
    ss.agents.push(main);
  }
  return main;
}

function spawnSubagent(ss, parentId, taskInput) {
  const subType = taskInput?.subagent_type || 'general-purpose';
  const desc = taskInput?.description || 'Subagent';
  const agent = {
    id: `agent-${agentIdCounter++}`,
    name: desc,
    color: pickAgentColor(),
    shape: pickAgentShape(),
    type: 'subagent',
    subagentType: subType,
    model: taskInput?.model || null,
    parentId,
    sessionId: ss.session.id,
    source: ss.session.source || 'unknown',
    status: 'active',
    spawnedAt: Date.now(),
    completedAt: null,
    toolCalls: [],
    toolCallCount: 0
  };
  ss.agents.push(agent);
  return agent;
}

function findActiveAgent(ss) {
  for (let i = ss.agents.length - 1; i >= 0; i--) {
    if (ss.agents[i].status === 'active') return ss.agents[i];
  }
  return ss.agents[0] || null;
}

// ─── Event Processing ──────────────────────────────────────────────────────────
function processEvent(event) {
  const { phase, timestamp, session_id, tool_name, tool_input, tool_response, model } = event;
  const sid = session_id || 'unknown';
  const source = detectSource(event);

  switch (phase) {
    case 'session_start': {
      // Allow multiple concurrent sessions — each gets its own orb
      // Reset this session if it already exists (re-opened), but preserve stats
      if (sessions.has(sid)) {
        const old = sessions.get(sid);
        carryOverStats.toolCalls += old.stats.toolCalls || 0;
        carryOverStats.filesAccessed += old.stats.filesAccessed || 0;
        carryOverStats.estimatedTokens += old.stats.estimatedTokens || 0;
        carryOverStats.linesAdded += old.stats.linesAdded || 0;
        carryOverStats.linesRemoved += old.stats.linesRemoved || 0;
        carryOverStats.turns += old.stats.turns || 0;
        carryOverStats.errors += old.stats.errors || 0;
        sessions.delete(sid);
      }
      const ss = getOrCreateSession(sid, timestamp, source);
      getOrCreateMainAgent(ss);
      break;
    }
    case 'session_end': {
      const ss = getSession(sid);
      if (ss) {
        ss.session.status = 'ended';
        ss.session.endedAt = timestamp;
        for (const agent of ss.agents) {
          if (agent.status === 'active') { agent.status = 'completed'; agent.completedAt = timestamp; }
        }
      }
      break;
    }
    case 'pre': {
      const ss = getOrCreateSession(sid, timestamp, source);
      reactivateIfEnded(ss, timestamp);
      const mainAgent = getOrCreateMainAgent(ss);

      // Capture model from transcript data
      if (model && !mainAgent.model) {
        mainAgent.model = model;
        ss.session.model = model;
      }

      if (tool_name === 'Task') {
        const sub = spawnSubagent(ss, mainAgent.id, tool_input);
        addTimelineEvent(ss, timestamp, 'agent_spawn', sub.id, { name: sub.name, subagentType: sub.subagentType, parentId: sub.parentId });
      }

      const agent = findActiveAgent(ss);
      if (agent) {
        const toolCall = {
          id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          tool: tool_name,
          inputSummary: summarizeInput(tool_name, tool_input),
          outputSummary: null,
          startedAt: timestamp,
          completedAt: null,
          status: 'executing'
        };
        agent.toolCalls.push(toolCall);
        agent.toolCallCount++;
        ss.stats.toolCalls++;
        ss.stats.estimatedTokens += estimateTokens(tool_input);
        ss.pendingToolCalls.set(tool_name, toolCall.id);
        trackFileAccess(ss, tool_name, tool_input, timestamp);
        addTimelineEvent(ss, timestamp, 'tool_start', agent.id, { toolCallId: toolCall.id, tool: tool_name, input: toolCall.inputSummary });
      }
      break;
    }
    case 'post': {
      const ss = getOrCreateSession(sid, timestamp, source);
      reactivateIfEnded(ss, timestamp);
      const agent = findActiveAgent(ss);
      if (agent) {
        const pendingId = ss.pendingToolCalls.get(tool_name);
        let toolCall = null;
        if (pendingId) {
          for (const a of ss.agents) {
            toolCall = a.toolCalls.find(tc => tc.id === pendingId);
            if (toolCall) break;
          }
          ss.pendingToolCalls.delete(tool_name);
        }
        if (toolCall) {
          toolCall.completedAt = timestamp;
          toolCall.outputSummary = summarizeOutput(tool_name, tool_response);
          const isError = detectError(tool_response);
          toolCall.status = isError ? 'error' : 'completed';
          if (isError) ss.stats.errors++;
        }
        ss.stats.estimatedTokens += estimateTokens(tool_response);
        if (tool_name === 'Task') {
          const lastSub = [...ss.agents].reverse().find(a => a.type === 'subagent' && a.status === 'active');
          if (lastSub) { lastSub.status = 'completed'; lastSub.completedAt = timestamp; }
        }
        addTimelineEvent(ss, timestamp, 'tool_end', agent.id, { tool: tool_name, output: toolCall?.outputSummary || null });
      }
      break;
    }
    case 'notification': {
      const ss = getOrCreateSession(sid, timestamp, source);
      reactivateIfEnded(ss, timestamp);
      ss.stats.turns++;
      const agent = findActiveAgent(ss);
      if (agent) {
        agent.lastResponse = event.message || null;
        addTimelineEvent(ss, timestamp, 'agent_response', agent.id, { message: truncate(event.message, 200) });
      }
      break;
    }
  }

  broadcast({ type: 'event', event, state: getPublicState() });
}

function countLines(str) { return str ? (str.match(/\n/g) || []).length + 1 : 0; }

function trackFileAccess(ss, toolName, toolInput, timestamp) {
  let filePath = null;
  if (['Read', 'Edit', 'Write'].includes(toolName)) filePath = toolInput?.file_path || toolInput?.path || null;
  else if (toolName === 'Glob') filePath = toolInput?.pattern || null;
  else if (toolName === 'Grep') filePath = toolInput?.path || null;

  // Track line changes for Write/Edit
  if (toolName === 'Write' && toolInput?.content) {
    ss.stats.linesAdded += countLines(toolInput.content);
  } else if (toolName === 'Edit' && toolInput) {
    const oldLines = countLines(toolInput.old_string);
    const newLines = countLines(toolInput.new_string);
    if (newLines > oldLines) ss.stats.linesAdded += newLines - oldLines;
    else if (oldLines > newLines) ss.stats.linesRemoved += oldLines - newLines;
  }

  if (filePath) {
    const existing = ss.files.get(filePath);
    if (existing) { existing.accessCount++; existing.lastAccessed = timestamp; }
    else { ss.files.set(filePath, { path: filePath, accessCount: 1, lastAccessed: timestamp, tool: toolName }); ss.stats.filesAccessed++; }
  }
}

function addTimelineEvent(ss, timestamp, type, agentId, data) {
  ss.timeline.push({ timestamp, type, agentId, data });
  const max = config.maxTimelineEvents || 1000;
  if (ss.timeline.length > max) ss.timeline = ss.timeline.slice(-max);
}

// ─── Token Estimation (~4 chars per token) ────────────────────────────────────
function estimateTokens(obj) {
  if (!obj) return 0;
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return Math.ceil(str.length / 4);
}

// ─── Summarization ─────────────────────────────────────────────────────────────
function summarizeInput(toolName, input) {
  if (!input) return null;
  const cases = {
    Read: () => input.file_path || null,
    Write: () => input.file_path || null,
    Edit: () => `${input.file_path || '?'} (edit)`,
    Bash: () => truncate(input.command, 120),
    Grep: () => `/${input.pattern || '?'}/ in ${input.path || '.'}`,
    Glob: () => input.pattern || null,
    Task: () => `[${input.subagent_type || '?'}] ${input.description || ''}`,
    WebSearch: () => input.query || null,
    WebFetch: () => input.url || null,
    TodoWrite: () => `${(input.todos || []).length} items`
  };
  const fn = cases[toolName];
  return fn ? fn() : truncate(JSON.stringify(input), 100);
}

function summarizeOutput(toolName, output) {
  if (!output) return null;
  if (typeof output === 'string') return truncate(output, 200);
  if (output.content) {
    const text = Array.isArray(output.content) ? output.content.map(c => c.text || '').join(' ') : String(output.content);
    return truncate(text, 200);
  }
  return truncate(JSON.stringify(output), 200);
}

function detectError(response) {
  if (!response) return false;
  // Check structured error indicators first
  if (typeof response === 'object' && response !== null) {
    if (response.is_error === true || response.isError === true) return true;
    if (response.error) return true;
  }
  const str = typeof response === 'string' ? response : JSON.stringify(response);
  if (str.length > 2000) return false; // Don't scan huge responses
  const lower = str.slice(0, 500).toLowerCase();
  // More specific patterns to reduce false positives from file content
  return lower.includes('command failed') || lower.includes('exit code')
    || lower.includes('error:') || lower.includes('fatal:')
    || lower.includes('traceback (most recent');
}

function truncate(str, max) {
  if (!str) return null;
  str = String(str);
  return str.length > max ? str.slice(0, max) + '...' : str;
}

// ─── Public State (aggregated across all sessions) ──────────────────────────
function getPublicState() {
  const allAgents = [];
  const allTimeline = [];
  const allFiles = [];
  // Start with carry-over from deleted sessions
  let totalToolCalls = carryOverStats.toolCalls;
  let totalFilesAccessed = carryOverStats.filesAccessed;
  let totalEstimatedTokens = carryOverStats.estimatedTokens;
  let totalLinesAdded = carryOverStats.linesAdded;
  let totalLinesRemoved = carryOverStats.linesRemoved;
  let totalTurns = carryOverStats.turns;
  let totalErrors = carryOverStats.errors;
  let totalActiveTools = 0;
  let earliestStart = null;
  const sessionList = [];

  for (const [sid, ss] of sessions) {
    sessionList.push(ss.session);
    for (const a of ss.agents) {
      allAgents.push({ ...a, sessionId: ss.session.id, source: a.source || ss.session.source || 'unknown', toolCalls: a.toolCalls.slice(-50) });
    }
    allTimeline.push(...ss.timeline);
    for (const f of ss.files.values()) allFiles.push(f);
    totalToolCalls += ss.stats.toolCalls;
    totalFilesAccessed += ss.stats.filesAccessed;
    totalEstimatedTokens += ss.stats.estimatedTokens || 0;
    totalLinesAdded += ss.stats.linesAdded || 0;
    totalLinesRemoved += ss.stats.linesRemoved || 0;
    totalTurns += ss.stats.turns || 0;
    totalErrors += ss.stats.errors || 0;
    totalActiveTools += ss.pendingToolCalls.size;
    if (ss.stats.startedAt && (!earliestStart || ss.stats.startedAt < earliestStart)) {
      earliestStart = ss.stats.startedAt;
    }
  }

  allTimeline.sort((a, b) => a.timestamp - b.timestamp);

  return {
    sessions: sessionList,
    session: sessionList.find(s => s.status === 'active') || sessionList[sessionList.length - 1] || null,
    agents: allAgents,
    timeline: allTimeline.slice(-500),
    files: allFiles.slice(-50),
    stats: {
      toolCalls: totalToolCalls,
      filesAccessed: totalFilesAccessed,
      startedAt: earliestStart,
      agentCount: allAgents.length,
      activeAgents: allAgents.filter(a => a.status === 'active').length,
      estimatedTokens: totalEstimatedTokens,
      linesAdded: totalLinesAdded,
      linesRemoved: totalLinesRemoved,
      turns: totalTurns,
      errors: totalErrors,
      activeTools: totalActiveTools,
      sessionCount: sessions.size,
      activeSessionCount: sessionList.filter(s => s.status === 'active').length
    },
    config
  };
}

// ─── Express App ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => res.sendFile(join(WEB_DIR, 'index.html')));
app.get('/app.js', (req, res) => res.type('application/javascript').sendFile(join(WEB_DIR, 'app.js')));
app.get('/style.css', (req, res) => res.type('text/css').sendFile(join(WEB_DIR, 'style.css')));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/api/state', (req, res) => res.json(getPublicState()));
app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  deepMerge(config, req.body);
  try { writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n'); } catch {}
  broadcast({ type: 'config_update', config });
  res.json({ status: 'ok', config });
});

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}
app.post('/api/events', (req, res) => { try { processEvent(req.body); res.json({ status: 'ok' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/voice-command', (req, res) => {
  const { transcript, timestamp } = req.body;
  if (transcript) {
    broadcast({ type: 'voice_transcript', transcript, timestamp: timestamp || Date.now() });
  }
  res.json({ status: 'ok' });
});
app.post('/api/admin/shutdown', (req, res) => { res.json({ status: 'shutting_down' }); process.exit(0); });

// ─── HTTP + WebSocket ──────────────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', state: getPublicState() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) { if (ws.readyState === 1) ws.send(msg); }
}

server.listen(PORT, HOST, () => {
  process.stderr.write(`[monikhao] Worker running at http://${HOST}:${PORT}\n`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
