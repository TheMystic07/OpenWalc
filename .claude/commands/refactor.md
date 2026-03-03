---
description: Refactor code — Claude identifies the improvement, Codex executes it.
argument-hint: extract the IPC handler from server/index.ts into its own module
allowed-tools: Read, Glob, Grep, Bash, Edit, Write, Task, mcp__codex
---

# Refactor via Codex

Claude architects the refactor. Codex moves the code.

## Workflow

1. **Understand the goal** from `$ARGUMENTS`. Common refactors for this project:
   - `server/index.ts` is ~45KB — extracting handlers into modules
   - Splitting large functions into smaller ones
   - Extracting shared constants or utilities
   - Improving type safety

2. **Read the code** that's being refactored. Understand all call sites and dependencies.

3. **Design the refactor**:
   - What moves where
   - What interfaces/types change
   - What imports need updating
   - Show the plan to user

4. **Delegate to Codex in stages** (don't do everything at once):
   - Stage 1: Create new file(s) with extracted code
   - Stage 2: Update imports in consuming files
   - Stage 3: Remove old code from source file

5. **Verify after each stage**:
   - `npx tsc --noEmit -p tsconfig.server.json` (server)
   - `npx tsc --noEmit` (frontend)
   - `npm test`

6. **Never change behavior** during a refactor. Same inputs → same outputs.

## Architecture Notes
- Server modules use ES module imports
- `server/types.ts` is shared between server and frontend
- Frontend imports from `../server/types.ts` for shared types
- Game loop depends on: command-queue, world-state, spatial-index, battle-manager, client-manager
