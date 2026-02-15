---
description: Install Monikhao agent monitor dependencies
---

Install the Monikhao agent monitor plugin. Follow these steps exactly:

1. Find the Monikhao directory. Check these locations in order:
   - ~/.config/opencode/plugins/Monikhao/
   - ~/.config/opencode/Monikhao/
   Verify the directory exists and contains `scripts/worker-service.cjs`.

2. Install Node.js dependencies inside the Monikhao directory:
   ```bash
   npm install --production
   ```
   If npm is unavailable, try:
   ```bash
   bun install --production
   ```

3. Verify that express and ws packages are installed:
   ```bash
   ls node_modules/express/package.json && ls node_modules/ws/package.json
   ```

4. Tell the user:
   - Dependencies installed successfully.
   - Restart OpenCode for the Monikhao agent monitor to activate.
   - After restart the 3D dashboard will be live at http://127.0.0.1:37800
