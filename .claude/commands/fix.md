---
description: Debug and fix a bug using Claude for diagnosis, Codex for the patch.
argument-hint: agents spawn on top of each other when many join at once
allowed-tools: Read, Glob, Grep, Bash, Edit, Write, Task, mcp__codex
---

# Fix Bug via Codex

Claude diagnoses. Codex patches.

## Workflow

1. **Reproduce understanding**: Read `$ARGUMENTS`. Identify the symptom and likely area of code.

2. **Investigate**: Read relevant source files to find the root cause.
   - Server bugs: check `server/index.ts`, `server/game-loop.ts`, `server/command-queue.ts`
   - Battle bugs: check `server/battle-manager.ts`
   - Position/spatial bugs: check `server/spatial-index.ts`, `server/world-state.ts`
   - Frontend rendering: check `src/scene/` files
   - UI bugs: check `src/ui/` files and `src/style.css`
   - WebSocket issues: check `server/ws-bridge.ts`, `src/net/ws-client.ts`

3. **Diagnose**: Identify the root cause. Explain it to the user clearly.

4. **Delegate fix to Codex**: Send Codex:
   - The file(s) to modify
   - The root cause explanation
   - The exact fix needed
   - Any test cases to add in `server/__tests__/`

5. **Verify**:
   - Run `npx tsc --noEmit -p tsconfig.server.json` and/or `npx tsc --noEmit`
   - Run `npm test`
   - If the fix touches battle/spatial/queue logic, check the relevant test file exists

6. **Never** just suppress errors or add try-catch as a band-aid. Fix the actual cause.
