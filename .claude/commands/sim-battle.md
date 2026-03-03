---
description: Simulate a battle flow by registering test agents and triggering combat.
allowed-tools: Bash
---

# Battle Simulation

Spin up two test agents, register them, and trigger a battle to verify the combat system works end-to-end.

## Prerequisites
Server must be running on localhost:18800.

## Steps

1. Check server health:
   ```
   curl -s http://localhost:18800/health
   ```
   Stop if server is not running.

2. Register two test agents:
   ```bash
   curl -s -X POST http://localhost:18800/ipc \
     -H "Content-Type: application/json" \
     -d '{"type":"command","command":"register","agentId":"test-agent-a","args":{"name":"TestLobsterA","color":"#ff4444"}}'

   curl -s -X POST http://localhost:18800/ipc \
     -H "Content-Type: application/json" \
     -d '{"type":"command","command":"register","agentId":"test-agent-b","args":{"name":"TestLobsterB","color":"#4444ff"}}'
   ```

3. Move them close together (within battle range):
   ```bash
   curl -s -X POST http://localhost:18800/ipc \
     -H "Content-Type: application/json" \
     -d '{"type":"command","command":"move","agentId":"test-agent-a","args":{"x":150,"y":150}}'

   curl -s -X POST http://localhost:18800/ipc \
     -H "Content-Type: application/json" \
     -d '{"type":"command","command":"move","agentId":"test-agent-b","args":{"x":152,"y":150}}'
   ```

4. Initiate battle:
   ```bash
   curl -s -X POST http://localhost:18800/ipc \
     -H "Content-Type: application/json" \
     -d '{"type":"command","command":"battle_challenge","agentId":"test-agent-a","args":{"targetId":"test-agent-b"}}'
   ```

5. Check battle status:
   ```bash
   curl -s http://localhost:18800/api/status | python3 -m json.tool 2>/dev/null || curl -s http://localhost:18800/api/status | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
   ```

6. Report the battle state and whether the flow succeeded or failed.

7. If `$ARGUMENTS` includes "cleanup", kick the test agents:
   ```bash
   curl -s -X POST http://localhost:18800/api/admin/kick \
     -H "Content-Type: application/json" \
     -H "X-Admin-Key: 6969" \
     -d '{"agentId":"test-agent-a"}'
   curl -s -X POST http://localhost:18800/api/admin/kick \
     -H "Content-Type: application/json" \
     -H "X-Admin-Key: 6969" \
     -d '{"agentId":"test-agent-b"}'
   ```
