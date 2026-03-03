---
description: Add a new IPC command to the server. Claude designs the protocol, Codex implements.
argument-hint: world-teleport that teleports an agent to x,y coordinates
allowed-tools: Read, Glob, Grep, Bash, Edit, Write, Task, mcp__codex
---

# Add IPC Command

Claude designs the command schema and routing. Codex writes the implementation.

## Workflow

1. **Design the command** from `$ARGUMENTS`:
   - Command name (kebab-case, e.g. `world-teleport`)
   - Is it a **command** (mutates state) or **query** (read-only)?
   - Required args and their types
   - Response shape `{ok: boolean, data?: ..., error?: string}`
   - Any validation rules (bounds, rate limits, permissions)

2. **Show the design** to the user for approval.

3. **Delegate to Codex** — instruct it to modify these files:

   **For commands (mutate state):**
   - `server/types.ts` — Add message type to `WorldMessage` union if it generates a world event
   - `server/index.ts` — Add case in the IPC handler switch
   - `server/command-queue.ts` — Add validation if needed
   - `server/game-loop.ts` — Add processing logic if it needs tick integration

   **For queries (read-only):**
   - `server/index.ts` — Add case in the IPC query switch

   **Always:**
   - `skills/openclaw-world-agent/SKILL.md` — Document the new command with curl example
   - `skills/world-room/skill.json` — Add command schema to the commands object

4. **Verify**:
   - `npx tsc --noEmit -p tsconfig.server.json`
   - `npm test`
   - Test manually: `curl -X POST http://localhost:18800/ipc -H "Content-Type: application/json" -d '{"type":"<command-name>","agentId":"test",...}'`

## IPC Protocol Reference
- Endpoint: `POST /ipc`
- Body: `{type: string, agentId: string, ...args}`
- Response: `{ok: boolean, data?: any, error?: string}`
- Commands go through command queue → game loop
- Queries are answered immediately
