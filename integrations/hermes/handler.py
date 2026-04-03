"""
Monikhao integration for Hermes Agent.

Forwards Hermes agent lifecycle events to Monikhao's worker service
for real-time 3D visualization. Translates Hermes hook payloads into
Monikhao's event format (phase, tool_name, tool_input, etc.).

Install:
    ln -s /path/to/monikhao/integrations/hermes ~/.hermes/hooks/monikhao
    # or copy the directory
"""

import os
import json
import time
import logging
from urllib.request import Request, urlopen
from urllib.error import URLError

logger = logging.getLogger("hooks.monikhao")

MONIKHAO_PORT = int(os.environ.get("AGENT_MONITOR_PORT", "37800"))
MONIKHAO_URL = f"http://127.0.0.1:{MONIKHAO_PORT}/api/events"

# Track pending tools from agent:step so we can close them on next step/end
_pending_tools = []


def _post_event(event):
    """Fire-and-forget POST to Monikhao worker. Never raises."""
    try:
        body = json.dumps(event).encode("utf-8")
        req = Request(MONIKHAO_URL, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        urlopen(req, timeout=2)
    except (URLError, OSError, ValueError):
        pass  # Worker not running or unreachable — silent


def _now():
    return int(time.time() * 1000)


def _session_id(ctx):
    return ctx.get("session_id") or ctx.get("session_key") or "hermes-unknown"


def _close_pending(ts):
    """Send post events for any tools still open from the previous step."""
    global _pending_tools
    for tool in _pending_tools:
        _post_event({
            "phase": "post",
            "timestamp": ts,
            "session_id": tool["session_id"],
            "source": "hermes",
            "tool_name": tool["tool_name"],
            "tool_input": None,
            "tool_response": None,
        })
    _pending_tools = []


# ─── Hermes Tool Name → Monikhao Tool Name ──────────────────────────────────
# Hermes uses lowercase snake_case tool names. Map known ones to Monikhao's
# PascalCase equivalents so summarizeInput() picks the right branch.
TOOL_NAME_MAP = {
    "bash": "Bash",
    "read_file": "Read",
    "write_file": "Write",
    "edit_file": "Edit",
    "search": "Grep",
    "glob": "Glob",
    "web_search": "WebSearch",
    "web_fetch": "WebFetch",
    "browser": "WebFetch",
    "todo": "TodoWrite",
}


def _map_tool_name(name):
    return TOOL_NAME_MAP.get(name, name)


async def handle(event_type, context):
    ts = _now()

    if event_type == "session:start":
        sid = _session_id(context)
        _post_event({
            "phase": "session_start",
            "timestamp": ts,
            "session_id": sid,
            "source": "hermes",
            "model": "hermes-agent",
            "tool_name": None,
            "tool_input": None,
            "tool_response": None,
        })
        logger.debug("monikhao: session_start %s", sid)

    elif event_type == "session:end":
        sid = _session_id(context)
        _close_pending(ts)
        _post_event({
            "phase": "session_end",
            "timestamp": ts,
            "session_id": sid,
            "source": "hermes",
            "tool_name": None,
            "tool_input": None,
            "tool_response": None,
        })
        logger.debug("monikhao: session_end %s", sid)

    elif event_type == "agent:start":
        sid = _session_id(context)
        msg = context.get("message", "")
        # Send as notification so the dashboard shows the user prompt
        _post_event({
            "phase": "notification",
            "timestamp": ts,
            "session_id": sid,
            "source": "hermes",
            "tool_name": None,
            "tool_input": None,
            "tool_response": msg[:200] if msg else None,
        })
        logger.debug("monikhao: agent:start %s", sid)

    elif event_type == "agent:step":
        sid = _session_id(context)
        iteration = context.get("iteration", 0)
        tool_names = context.get("tool_names", [])

        # Close tools from previous step
        _close_pending(ts)

        # Open new tools from this step
        _pending_tools = []
        for raw_name in tool_names:
            mapped = _map_tool_name(raw_name)
            entry = {"session_id": sid, "tool_name": mapped}
            _pending_tools.append(entry)

            _post_event({
                "phase": "pre",
                "timestamp": ts,
                "session_id": sid,
                "source": "hermes",
                "tool_name": mapped,
                "tool_input": {"tool": raw_name, "iteration": iteration},
                "tool_response": None,
            })

        logger.debug(
            "monikhao: agent:step %s iter=%d tools=%s",
            sid, iteration, tool_names,
        )

    elif event_type == "agent:end":
        sid = _session_id(context)
        response = context.get("response", "")

        # Close any remaining open tools
        _close_pending(ts)

        # Send response as notification
        _post_event({
            "phase": "notification",
            "timestamp": ts,
            "session_id": sid,
            "source": "hermes",
            "tool_name": None,
            "tool_input": None,
            "tool_response": response[:200] if response else None,
        })
        logger.debug("monikhao: agent:end %s", sid)
