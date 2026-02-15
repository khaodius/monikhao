---
description: Stop the Monikhao agent monitor worker
---

Stop the Monikhao agent monitor worker service. Follow these steps:

1. Send the shutdown command:
   ```bash
   curl -s -X POST http://127.0.0.1:37800/api/admin/shutdown
   ```
   If it returns `{"status":"shutting_down"}`, the worker has been stopped.

2. If the curl fails (connection refused), the worker is already stopped. Tell the user.

3. Confirm the worker is down:
   ```bash
   curl -s http://127.0.0.1:37800/api/health
   ```
   This should fail with connection refused.

4. Tell the user the Monikhao worker has been stopped. It will auto-start again on next OpenCode or Claude Code session, or they can run /kmoni-on to start it manually.
