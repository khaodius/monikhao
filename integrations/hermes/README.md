# Monikhao × Hermes Agent Integration

Monitor [Hermes Agent](https://github.com/nousresearch/hermes-agent) sessions on the Monikhao 3D dashboard.

## Install

Symlink (recommended) or copy this directory into Hermes's hooks folder:

```bash
ln -s /path/to/monikhao/integrations/hermes ~/.hermes/hooks/monikhao
```

Make sure the Monikhao worker is running (default port `37800`). If using a custom port, set `AGENT_MONITOR_PORT` before starting the Hermes gateway.

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

| Env Variable         | Default | Description              |
|----------------------|---------|--------------------------|
| `AGENT_MONITOR_PORT` | `37800` | Monikhao worker port     |
