---
description: Fetch and display the current world state from a running server.
allowed-tools: Bash
---

# World Snapshot

Fetch the live world state and display it in a readable format.

## Steps

1. Check if server is running:
   ```
   curl -s http://localhost:18800/health
   ```
   If not running, tell the user and stop.

2. Fetch status:
   ```
   curl -s http://localhost:18800/api/status
   ```

3. Display a formatted summary:
   - **Room**: name, ID, phase, uptime
   - **Agents** (table): name, status (alive/dead), position, HP, kills/deaths
   - **Active Battles** (table): battle ID, participants, turn count
   - **Recent Events**: last 5 world events if available

4. If `$ARGUMENTS` includes "agents", also fetch detailed agent profiles:
   ```
   curl -s "http://localhost:18800/api/admin/dead-agents" -H "X-Admin-Key: 6969"
   ```

5. Keep output compact. Use tables and short labels.
