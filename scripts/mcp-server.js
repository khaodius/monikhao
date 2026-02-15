/**
 * mcp-server.js - Lightweight MCP stdio server for Monikhao.
 * Provides tools for Claude to query dashboard status and update config.
 */
import { createInterface } from 'readline';
import { request } from 'http';

const PORT = 37800;

const rl = createInterface({ input: process.stdin, terminal: false });

const TOOLS = [
  {
    name: 'monikhao_status',
    description: 'Get the Monikhao dashboard URL and current session stats (agent count, tool calls, uptime)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'monikhao_config',
    description: 'Get or set Monikhao configuration values (port, colors, animation speed, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '"get" to retrieve current config, "set" to update values',
          enum: ['get', 'set']
        },
        updates: {
          type: 'object',
          description: 'Key-value pairs to update when action is "set"'
        }
      },
      required: ['action']
    }
  }
];

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: PORT, path, method: 'GET', timeout: 3000
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function httpPost(path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = request({
      hostname: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 3000
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function handleToolCall(id, name, args) {
  try {
    if (name === 'monikhao_status') {
      let stats;
      try {
        const st = await httpGet('/api/state');
        stats = st.stats || {};
      } catch {
        return respond(id, {
          content: [{ type: 'text', text: 'Monikhao worker is not running. Dashboard URL: http://localhost:37800' }]
        });
      }
      const lines = [
        `Dashboard: http://localhost:${PORT}`,
        `Session: ${st?.session?.status || 'none'}`,
        `Agents: ${stats.agentCount || 0} (${stats.activeAgents || 0} active)`,
        `Tool calls: ${stats.toolCalls || 0}`,
        `Files accessed: ${stats.filesAccessed || 0}`
      ];
      return respond(id, { content: [{ type: 'text', text: lines.join('\n') }] });
    }

    if (name === 'monikhao_config') {
      if (args.action === 'get') {
        const cfg = await httpGet('/api/config');
        return respond(id, { content: [{ type: 'text', text: JSON.stringify(cfg, null, 2) }] });
      }
      if (args.action === 'set' && args.updates) {
        const result = await httpPost('/api/config', args.updates);
        return respond(id, { content: [{ type: 'text', text: `Config updated: ${JSON.stringify(result.config, null, 2)}` }] });
      }
      return respond(id, { content: [{ type: 'text', text: 'Usage: action="get" or action="set" with updates object' }] });
    }

    respondError(id, -32601, `Unknown tool: ${name}`);
  } catch (e) {
    respondError(id, -32603, e.message);
  }
}

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'monikhao', version: '1.0.0' }
      });

    case 'notifications/initialized':
      // No response needed for notifications
      return;

    case 'tools/list':
      return respond(id, { tools: TOOLS });

    case 'tools/call':
      return await handleToolCall(id, params?.name, params?.arguments || {});

    default:
      if (id !== undefined) {
        respondError(id, -32601, `Unknown method: ${method}`);
      }
  }
});
