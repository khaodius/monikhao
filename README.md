# Monikhao

This serves quite literally no use, but, this is a real-time 3D dashboard that visualizes AI coding agent sessions using Three.js. Works with both **Claude Code** and **OpenCode** simultaneously on the same dashboard. Watch your agents work in a living, breathing environment -- orbs pulse with heartbeat rhythms on tool execution, orbital particles drift and connect with proximity lines, subagents spawn with particle bursts and dissolve when complete, and connection energy flows between parent and child agents.

![Dashboard](https://img.shields.io/badge/dashboard-Three.js-blue) ![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![License](https://img.shields.io/badge/license-MIT-brightgreen)

## Features

- **Multi-Platform** -- Claude Code and OpenCode sessions appear side-by-side, each tagged with their source platform
- **3D Agent Visualization** -- Each session appears as a glowing orb with orbital particles, rings, and dynamic lighting; random unique names and colors per agent
- **Live Tool Tracking** -- Every tool call (Read, Write, Bash, Grep, etc.) triggers visual events: thought bubbles, color-coded particles, and timeline entries
- **Model Detection** -- Automatically detects and displays the AI model in use (e.g. "Opus 4.6", "Sonnet 4.5") on each agent
- **Cost Estimation** -- Real-time token counting with estimated cost based on actual Anthropic/OpenAI pricing (configurable model)
- **Subagent Trees** -- Spawned subagents (Explore, Plan, Bash, etc.) orbit their parent with connection lines and energy flow particles
- **Canvas2D Backgrounds** -- 12 animated background types
- **Heartbeat Breathing** -- Orbs pulse with a double-beat gaussian waveform tied to execution activity
- **Proximity Lines** -- Orbital particles draw fading connections when they drift near each other
- **Ambient Audio** -- Synthesized Web Audio API soundscape with tool-specific tones, spawn arpeggios, and completion chords
- **Completion Dissolution** -- Finished subagents flash, emit homing arc particles toward their parent, and dissolve
- **CSS2D Labels & Panels** -- Crisp HTML labels and station panels positioned in 3D space
- **Custom Themes** -- 6 built-in color themes (purple, cyan, emerald, rose, amber, crimson) plus a custom color picker
- **Stats Bar** -- Live session metrics: agents, tool calls, tools/min, errors, files touched, line changes, token estimate, cost, turns, uptime, FPS
- **Session Cleanup** -- Ghost sessions (0 tool calls, idle 15s) auto-pruned; stale sessions expire after 5 minutes of inactivity
- **Configurable** -- Toggle labels, audio, auto-focus, background type/symbols/opacity, theme, pricing model, and more from the config tab

## Requirements

- Node.js 18+
- Claude Code CLI/VS extension with plugin support, and/or OpenCode CLI/IDE

## Installation

### Claude Code Plugin

1. **Clone or download** this repository somewhere permanent (it stays here — Claude Code references it):

   ```bash
   git clone https://github.com/khaodius/monikhao.git ~/Monikhao
   cd ~/Monikhao
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Register the plugin** by adding an entry to `~/.claude/plugins/installed_plugins.json`. Create the file if it doesn't exist. If other plugins are already listed, append this object to the existing array:

   ```json
   [
   	{
   		"id": "monikhao/monikhao/1.0.0",
   		"name": "monikhao",
   		"version": "1.0.0",
   		"marketplace": "monikhao",
   		"installPath": "/absolute/path/to/Monikhao"
   	}
   ]
   ```

   > Replace `installPath` with the **absolute path** to your cloned directory (e.g. `"/home/user/Monikhao"` or `"C:\\Users\\user\\Monikhao"`).

4. **Link the plugin cache.** Claude Code loads hooks from a cache directory, not from `installPath` directly. Create a symlink (or junction on Windows) that points the cache path to your cloned directory:

   **macOS / Linux:**

   ```bash
   mkdir -p ~/.claude/plugins/cache/monikhao
   ln -s /absolute/path/to/Monikhao ~/.claude/plugins/cache/monikhao/monikhao/1.0.0
   ```

   **Windows (PowerShell, no admin required):**

   ```powershell
   New-Item -ItemType Directory -Path "$env:USERPROFILE\.claude\plugins\cache\monikhao" -Force
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\plugins\cache\monikhao\monikhao\1.0.0" -Target "C:\absolute\path\to\Monikhao"
   ```

   > The final cache path must be `~/.claude/plugins/cache/monikhao/monikhao/1.0.0/` and contain the `hooks/` folder. You can verify with:
   >
   > ```bash
   > ls ~/.claude/plugins/cache/monikhao/monikhao/1.0.0/hooks/
   > # Should show: hooks.json
   > ```

5. **Start a new Claude Code session.** The plugin's session-start hook automatically spawns the worker process and the dashboard is live at `http://127.0.0.1:37800`. Open it in any browser.

### OpenCode (Global Plugin)

1. Copy both `monikhao.js` and the `Monikhao/` folder into `~/.config/opencode/plugins/`:

   ```
   ~/.config/opencode/plugins/
     monikhao.js        <- plugin entry point (auto-loaded by OpenCode)
     Monikhao/          <- this project folder
   ```

2. Start OpenCode and run the install command:

   ```
   /kmoni-install
   ```

   This installs the Node.js dependencies (`express`, `ws`) inside the `Monikhao/` folder.

3. Restart OpenCode. The worker auto-starts and the dashboard is live at `http://127.0.0.1:37800`. If it does not, run
 ```
   /kmoni-install
 ```

**How the bootstrap works:**

- `monikhao.js` is a thin loader with zero external dependencies. On first load it:
  1. Discovers the `Monikhao/` folder (checks sibling dir, parent dir, `MONIKHAO_PATH` env var)
  2. Creates the `/kmoni-install` command in `~/.config/opencode/commands/` if it doesn't exist
  3. If `node_modules/` is present -- activates full plugin (tool hooks, session events, worker spawn)
  4. If `node_modules/` is missing -- stays dormant until you run `/kmoni-install`
- On process exit (Ctrl+C, terminal close), the plugin sends a synchronous `session_end` event to clean up the session on the dashboard.

### Manual Start

If you want to run the worker manually without any plugin hooks:

```bash
node scripts/worker-service.cjs
```

Then open `http://127.0.0.1:37800` in your browser.

## Cross-Platform Coexistence

Claude Code and OpenCode share a **single worker process** on port 37800. Only one instance runs -- whichever platform starts first spawns the worker, the other detects it via health check and connects.

### Source Tagging

Every session and agent is tagged with a `source` field:

| Platform    | Source value | How detected                                               |
| ----------- | ------------ | ---------------------------------------------------------- |
| OpenCode    | `opencode`   | Explicit `source: 'opencode'` in events from `monikhao.js` |
| Claude Code | `claudecode` | Inferred by the worker (session IDs without `oc-` prefix)  |

### Shared Worker Resolution

The worker (`worker-service.cjs`) resolves its root directory (for `config.json` and `web/` assets) using:

```
1. MONIKHAO_ROOT env var  (set by the OpenCode bootstrap when spawning)
2. resolve(__dirname, '..')  (fallback, used by Claude Code hooks)
```

Both paths lead to the same project folder, ensuring consistent config and dashboard assets regardless of who started the worker.

### Session Lifecycle

- **OpenCode**: The `monikhao.js` bootstrap sends `session_end` on `session.deleted`, `session.error`, and on process exit (SIGINT/SIGTERM/beforeExit) via a synchronous HTTP request.
- **Claude Code**: The `session-stop-hook.cjs` sends `session_end` via the Stop hook.
- **Ghost pruning**: Sessions with 0 tool calls that sit idle for 15 seconds are automatically removed.
- **Stale cleanup**: Sessions with no activity for 5 minutes are auto-expired by the worker. Ended sessions are removed from state after 2 minutes.

## Architecture

```
Monikhao/
├── .claude-plugin/
│   └── plugin.json             # Claude Code plugin metadata
├── hooks/
│   └── hooks.json              # Claude Code hook definitions
├── plugins/
│   └── opencode.js             # OpenCode adapter (legacy reference)
├── commands/
│   └── kmoni-install.md        # /kmoni-install command (bundled copy)
├── scripts/
│   ├── worker-service.cjs      # Express + WebSocket server (port 37800)
│   ├── session-start-hook.cjs  # [Claude Code] Spawns worker, sends session_start
│   ├── session-stop-hook.cjs   # [Claude Code] Sends session_end
│   ├── event-hook.cjs          # [Claude Code] Forwards tool events + extracts model/thinking
│   ├── notification-hook.cjs   # [Claude Code] Captures response text
│   └── mcp-server.js           # MCP server for dashboard tools
├── web/
│   ├── index.html              # Dashboard HTML + Three.js importmap
│   ├── app.js                  # Three.js scene, WebSocket client, all visuals
│   └── style.css               # Dashboard styles
├── monikhao.js                 # OpenCode bootstrap plugin (zero-dep loader)
├── config.json                 # Runtime configuration
├── package.json                # Dependencies (express, ws)
├── LICENSE                     # MIT
└── README.md
```

### How It Works

1. **Hooks** -- The AI tool fires lifecycle events through its hook system:
   - **Claude Code**: Shell scripts (`.cjs`) receive JSON via stdin and POST to the worker. The event hook also reads the transcript JSONL to extract the model ID and latest thinking text.
   - **OpenCode**: `monikhao.js` plugin receives `tool.execute.before`, `tool.execute.after`, and `event` callbacks, then POSTs to the worker
2. **Worker** -- Both adapters POST the same event format to a persistent Express server (`worker-service.cjs`) that manages multi-session state, agent trees, and statistics
3. **WebSocket** -- The worker broadcasts state changes to connected browser clients in real-time
4. **Dashboard** -- `app.js` renders the 3D scene using Three.js, creating/updating/removing agent orbs as events stream in

### Event Format

All events POSTed to `POST /api/events` follow this schema:

```json
{
	"phase": "session_start | session_end | pre | post | notification",
	"timestamp": 1700000000000,
	"session_id": "oc-1700000000000-abc123",
	"source": "opencode | claudecode",
	"tool_name": "Read | Write | Edit | Bash | Grep | Glob | Task | ...",
	"tool_input": {},
	"tool_response": null,
	"thinking": "Latest thinking text (pre events only, max 300 chars)",
	"model": "claude-opus-4-6-20250514",
	"cwd": "/path/to/working/directory"
}
```

- `source` is optional; if omitted the worker infers it from the session ID prefix (`oc-` -> opencode, else -> claudecode)
- `phase: pre` is sent before a tool executes, `phase: post` after
- `phase: notification` carries a `message` field with assistant text or lifecycle info
- `thinking` and `model` are extracted from the Claude Code transcript on `pre` events
- `cwd` is the working directory of the session

## Configuration

Edit `config.json` or use the Config tab in the dashboard:

### Theme

| Setting               | Default     | Description                                                                     |
| --------------------- | ----------- | ------------------------------------------------------------------------------- |
| `display.theme`       | `"purple"`  | Color theme (`purple`, `cyan`, `emerald`, `rose`, `amber`, `crimson`, `custom`) |
| `display.customColor` | `"#b050ff"` | Custom accent color (hex, used when theme is `custom`)                          |

### Animation

| Setting                      | Default  | Description                   |
| ---------------------------- | -------- | ----------------------------- |
| `animation.speed`            | `0.1`    | Animation speed multiplier    |
| `animation.autoRotate`       | `true`   | Camera auto-rotation          |
| `animation.orbitSpeed`       | `0.0015` | Orbital particle speed        |
| `animation.particleLifetime` | `120000` | Particle lifetime in ms       |
| `animation.maxFps`           | `110`    | Frame rate cap (0 = uncapped) |

### Display

| Setting                    | Default   | Description                      |
| -------------------------- | --------- | -------------------------------- |
| `display.showFps`          | `true`    | Show FPS counter in stats bar    |
| `display.showLabels`       | `true`    | Show agent name labels           |
| `display.autoFocus`        | `true`    | Camera follows active agent      |
| `display.asciiRain`        | `true`    | Enable background animation      |
| `display.bgType`           | `"waves"` | Background type (see list below) |
| `display.waveSymbols`      | `"dots"`  | Symbol preset for background     |
| `display.asciiRainDensity` | `1`       | Background intensity (0.3-1.0)   |
| `display.bgOpacity`        | `100`     | Background opacity (0-100)       |
| `display.wireThickness`    | `2`       | Proximity wire thickness in px   |
| `display.wireDistance`     | `1.8`     | Proximity wire trigger distance  |

**Background types:** waves, plasma, fire, topology, ripples, fractal, lissajous, snow, hyperbolic, spiral, moire, flow field

**Symbol presets:** dots, runes, alchemical, zodiac, occult, sigils, geometric, katakana, binary, blocks, braille, circuit, arrows, math, chess, hacker

### Pricing

| Setting         | Default      | Description                                                     |
| --------------- | ------------ | --------------------------------------------------------------- |
| `pricing.model` | `"opus-4.6"` | Model for cost estimation (Anthropic + OpenAI models supported) |

### Features

| Setting                    | Default | Description              |
| -------------------------- | ------- | ------------------------ |
| `features.ambientAudio`    | `false` | Enable synthesized audio |
| `features.audioVolume`     | `50`    | Audio volume (0-100)     |
| `features.thoughtBubbles`  | `true`  | Show tool call bubbles   |
| `features.spawnAnimations` | `true`  | Subagent spawn effects   |

### Environment Variables

| Variable             | Description                                                          |
| -------------------- | -------------------------------------------------------------------- |
| `AGENT_MONITOR_PORT` | Override the worker port (default `37800`)                           |
| `MONIKHAO_PATH`      | Override the Monikhao project root path (for the OpenCode bootstrap) |
| `MONIKHAO_ROOT`      | Override the project root path (for the worker process)              |

## API Endpoints

| Method | Path                  | Description                                                    |
| ------ | --------------------- | -------------------------------------------------------------- |
| `GET`  | `/`                   | Dashboard HTML                                                 |
| `GET`  | `/api/health`         | Health check (`{ status: 'ok', uptime }`)                      |
| `GET`  | `/api/state`          | Full current state (sessions, agents, timeline, stats, config) |
| `GET`  | `/api/config`         | Current configuration                                          |
| `POST` | `/api/config`         | Update configuration (deep merge)                              |
| `POST` | `/api/events`         | Ingest an event (see Event Format above)                       |
| `POST` | `/api/admin/shutdown` | Gracefully shut down the worker                                |
| `WS`   | `/`                   | WebSocket connection for real-time state updates               |

## License

MIT
