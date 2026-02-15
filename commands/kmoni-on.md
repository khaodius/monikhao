---
description: Start the Monikhao agent monitor worker
---

Start the Monikhao agent monitor worker service. Follow these steps:

1. First check if it's already running:
   ```bash
   curl -s http://127.0.0.1:37800/api/health
   ```
   If it returns `{"status":"ok"...}`, tell the user the worker is already running and the dashboard is at http://127.0.0.1:37800

2. If the health check fails, find the Monikhao directory (check `~/.config/opencode/plugins/Monikhao/` or `~/.config/opencode/Monikhao/`) and start the worker as a detached background process:
   ```bash
   nohup node ~/.config/opencode/plugins/Monikhao/scripts/worker-service.cjs > /dev/null 2>&1 &
   ```
   On Windows:
   ```bash
   start /b node ~/.config/opencode/plugins/Monikhao/scripts/worker-service.cjs
   ```

3. Wait 2 seconds, then verify it started:
   ```bash
   curl -s http://127.0.0.1:37800/api/health
   ```

4. Tell the user the dashboard is live at http://127.0.0.1:37800
