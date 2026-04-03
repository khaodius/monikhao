"""
Monikhao integration for Hermes Agent.

Forwards Hermes agent lifecycle events to Monikhao's worker service
for real-time 3D visualization. Translates Hermes hook payloads into
Monikhao's event format (phase, tool_name, tool_input, etc.).

Auto-spawns the Monikhao worker on first event if not already running.

Install:
    ln -s /path/to/monikhao/integrations/hermes ~/.hermes/hooks/monikhao
    # or copy the directory

Config env vars:
    AGENT_MONITOR_PORT  - Worker port (default: 37800)
    MONIKHAO_ROOT       - Path to Monikhao install (auto-detected from hook location)
"""

import os
import json
import time
import shutil
import signal
import logging
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

logger = logging.getLogger("hooks.monikhao")

MONIKHAO_PORT = int(os.environ.get("AGENT_MONITOR_PORT", "37800"))
MONIKHAO_URL = f"http://127.0.0.1:{MONIKHAO_PORT}/api/events"

# Resolve Monikhao root: env var > 2 dirs up from this file (integrations/hermes/handler.py)
_THIS_DIR = Path(__file__).resolve().parent
MONIKHAO_ROOT = Path(os.environ.get("MONIKHAO_ROOT", _THIS_DIR.parent.parent))
DATA_DIR = Path.home() / ".monikhao"
PID_FILE = DATA_DIR / "worker.pid"
LOCK_FILE = DATA_DIR / "spawn.lock"
LOG_FILE = DATA_DIR / "debug.log"
WORKER_STDERR = DATA_DIR / "worker-stderr.log"
WORKER_SCRIPT = MONIKHAO_ROOT / "scripts" / "worker-service.cjs"

# Track pending tools from agent:step so we can close them on next step/end
_pending_tools = []
_worker_ensured = False  # Skip health checks after first successful contact


# ─── Worker Lifecycle ────────────────────────────────────────────────────────

def _debug_log(msg):
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] [hermes] {msg}\n")
    except OSError:
        pass


def _is_healthy():
    """Check if the worker is responding on the health endpoint."""
    try:
        req = Request(
            f"http://127.0.0.1:{MONIKHAO_PORT}/api/health",
            method="GET",
        )
        resp = urlopen(req, timeout=2)
        return resp.status == 200
    except (URLError, OSError):
        return False


def _kill_stale_worker():
    """Kill a previously recorded worker process if still alive."""
    try:
        if not PID_FILE.exists():
            return
        info = json.loads(PID_FILE.read_text())
        pid = info.get("pid")
        if not pid:
            return
        os.kill(pid, signal.SIGTERM)
        _debug_log(f"Killed stale worker PID: {pid}")
    except (OSError, json.JSONDecodeError, KeyError):
        pass


def _acquire_lock():
    """Prevent concurrent spawn attempts. Returns True if lock acquired."""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if LOCK_FILE.exists():
            lock_data = json.loads(LOCK_FILE.read_text())
            if time.time() * 1000 - lock_data.get("ts", 0) < 20000:
                _debug_log("Spawn lock held, skipping")
                return False
        LOCK_FILE.write_text(json.dumps({"ts": time.time() * 1000, "pid": os.getpid()}))
        return True
    except OSError:
        return False


def _release_lock():
    try:
        LOCK_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def _wait_for_health(timeout_s=15):
    """Poll health endpoint until healthy or timeout."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if _is_healthy():
            return True
        time.sleep(0.3)
    return False


def _ensure_worker():
    """Spawn the Monikhao worker if it's not already running."""
    global _worker_ensured
    if _worker_ensured:
        return True

    # Fast path: already running
    if _is_healthy():
        _worker_ensured = True
        return True

    _debug_log("Worker not healthy, attempting spawn...")

    # Find node binary
    node = shutil.which("node")
    if not node:
        _debug_log("node not found in PATH, cannot spawn worker")
        return False

    # Check worker script exists
    if not WORKER_SCRIPT.exists():
        _debug_log(f"Worker script not found: {WORKER_SCRIPT}")
        return False

    if not _acquire_lock():
        healthy = _wait_for_health(20)
        if healthy:
            _worker_ensured = True
        return healthy

    try:
        # Re-check after acquiring lock
        if _is_healthy():
            _worker_ensured = True
            return True

        _kill_stale_worker()
        time.sleep(0.5)

        # Open stderr log
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        stderr_fd = open(WORKER_STDERR, "w")

        env = {**os.environ, "AGENT_MONITOR_PORT": str(MONIKHAO_PORT), "MONIKHAO_ROOT": str(MONIKHAO_ROOT)}

        proc = subprocess.Popen(
            [node, str(WORKER_SCRIPT)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=stderr_fd,
            env=env,
            cwd=str(MONIKHAO_ROOT),
            start_new_session=True,
        )

        if proc.pid:
            PID_FILE.write_text(json.dumps({
                "pid": proc.pid,
                "port": MONIKHAO_PORT,
                "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }))
            _debug_log(f"Spawned worker PID: {proc.pid}")
        else:
            _debug_log("Failed to spawn worker - no PID")
            stderr_fd.close()
            return False

        stderr_fd.close()

        healthy = _wait_for_health(15)
        _debug_log(f"Health after spawn: {healthy}")
        if healthy:
            _worker_ensured = True
        else:
            try:
                err = WORKER_STDERR.read_text().strip()
                if err:
                    _debug_log(f"Worker stderr: {err[:500]}")
            except OSError:
                pass

        return healthy
    finally:
        _release_lock()


# ─── Event Posting ───────────────────────────────────────────────────────────

def _post_event(event):
    """POST event to Monikhao worker. Ensures worker is running first."""
    _ensure_worker()
    try:
        body = json.dumps(event).encode("utf-8")
        req = Request(MONIKHAO_URL, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        urlopen(req, timeout=2)
    except (URLError, OSError, ValueError):
        pass


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


# ─── Hook Entry Point ───────────────────────────────────────────────────────

async def handle(event_type, context):
    global _pending_tools
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

        _close_pending(ts)

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

        logger.debug("monikhao: agent:step %s iter=%d tools=%s", sid, iteration, tool_names)

    elif event_type == "agent:end":
        sid = _session_id(context)
        response = context.get("response", "")

        _close_pending(ts)

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
