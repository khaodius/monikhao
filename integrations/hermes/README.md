# Monikhao × Hermes Agent Integration

Monitor [Hermes Agent](https://github.com/nousresearch/hermes-agent) sessions on the Monikhao 3D dashboard.

## Install

Symlink (recommended) or copy this directory into Hermes's hooks folder:

```bash
ln -s /path/to/monikhao/integrations/hermes ~/.hermes/hooks/monikhao
```

The worker auto-spawns on the first Hermes event if it's not already running — no manual startup needed. Requires `node` in PATH.

## What gets tracked

| Hermes Event   | Dashboard Effect                          |
|----------------|-------------------------------------------|
| session:start  | New session orb appears                   |
| session:end    | Session marked complete                   |
| agent:start    | User message shown as notification        |
| agent:step     | Each tool lights up on the timeline       |
| agent:end      | Agent response shown, tools finalized     |

## Tool name mapping

Hermes uses snake_case tool names (`bash`, `read_file`, `edit_file`). The handler maps them to Monikhao's PascalCase equivalents so the dashboard renders familiar icons and summaries.

## Configuration

| Env Variable         | Default       | Description                                      |
|----------------------|---------------|--------------------------------------------------|
| `AGENT_MONITOR_PORT` | `37800`       | Monikhao worker port                             |
| `AGENT_MONITOR_HOST` | `0.0.0.0`    | Bind address (`0.0.0.0` = LAN accessible)        |
| `MONIKHAO_ROOT`      | *(auto)*      | Path to Monikhao install (resolved from symlink) |
