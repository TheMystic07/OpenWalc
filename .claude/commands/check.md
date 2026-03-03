---
description: Run full project health check — types, tests, and lint.
allowed-tools: Bash
---

# Full Project Health Check

Run all verification steps in parallel and report results.

## Steps

1. Run these **in parallel** (all independent):
   - `npx tsc --noEmit` (frontend types)
   - `npx tsc --noEmit -p tsconfig.server.json` (server types)
   - `npm test` (vitest)

2. Report a summary:
   - Types: pass/fail (frontend + server)
   - Tests: X passed, Y failed
   - Any errors with file:line references

3. If everything passes, say so briefly. Don't over-explain success.
