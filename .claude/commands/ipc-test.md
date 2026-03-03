---
description: Test IPC endpoints against a running server.
allowed-tools: Bash
---

# IPC Endpoint Tester

Test the server's IPC and REST endpoints to verify they're working.

## Steps

1. First check if server is running:
   ```
   curl -s http://localhost:18800/health
   ```
   If not running, tell the user and stop.

2. Run these endpoint tests **in parallel**:
   - `GET /health` — should return JSON with status
   - `GET /api/status` — should return room info, agents, battles
   - `POST /ipc` with `{"type":"query","command":"world_state"}` — should return world snapshot

3. If `$ARGUMENTS` includes a specific command name, also test that:
   ```
   curl -s -X POST http://localhost:18800/ipc \
     -H "Content-Type: application/json" \
     -d '{"type":"query","command":"$ARGUMENTS"}'
   ```

4. Report results as a table:
   | Endpoint | Status | Response Time | Notes |

5. Flag any errors, unexpected status codes, or slow responses (>500ms).
