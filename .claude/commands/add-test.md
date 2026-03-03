---
description: Add or improve tests for a server module. Claude identifies coverage gaps, Codex writes tests.
argument-hint: battle-manager edge cases for simultaneous surrender
allowed-tools: Read, Glob, Grep, Bash, Edit, Write, Task, mcp__codex
---

# Add Tests via Codex

Claude identifies what to test. Codex writes the test code.

## Workflow

1. **Identify target** from `$ARGUMENTS`. Map to test file:
   - `server/battle-manager.ts` → `server/__tests__/battle-manager.test.ts`
   - `server/spatial-index.ts` → `server/__tests__/spatial-index.test.ts`
   - `server/command-queue.ts` → `server/__tests__/command-queue.test.ts`
   - `server/room-config.ts` → `server/__tests__/room-config.test.ts`
   - New module → create `server/__tests__/<module>.test.ts`

2. **Read the source** and existing tests to understand:
   - What's already covered
   - What edge cases are missing
   - How tests are structured (imports, mocking patterns)

3. **List the test cases** needed. Show to user.

4. **Delegate to Codex**: Give it:
   - The test file path
   - The test cases to write
   - Import patterns from existing tests
   - Any mocking needed (this project uses minimal mocking — prefer testing real logic)

5. **Run and verify**:
   - `npm test` — all tests pass
   - `npm run test:coverage` — check coverage improved

## Testing Conventions
- Framework: Vitest
- Tests in `server/__tests__/`
- Coverage thresholds: 60% lines/functions, 50% branches
- Prefer testing actual logic over mocking
- Use `describe`/`it` blocks with clear names
