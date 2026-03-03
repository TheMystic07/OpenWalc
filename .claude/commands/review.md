---
description: Review recent changes or a specific file for issues, security, and quality.
argument-hint: server/index.ts
allowed-tools: Read, Glob, Grep, Bash
---

# Code Review

Claude-only task — no Codex needed. Read and analyze code.

## Workflow

1. **Identify scope** from `$ARGUMENTS`:
   - If a file path: review that file
   - If "recent": run `git diff HEAD~1` to see latest changes
   - If a feature name: find related files with Grep/Glob

2. **Review for**:
   - **Security**: Command injection in IPC handler, XSS in chat messages, unbounded input sizes
   - **Race conditions**: Concurrent agent commands, battle state corruption, profile save conflicts
   - **Memory leaks**: Event listeners not cleaned up, growing maps/arrays without bounds
   - **Performance**: O(n²) loops in hot paths (game loop runs at 20Hz), unnecessary spatial rebuilds
   - **Type safety**: Any `as any` casts, missing null checks, unhandled discriminated union cases
   - **Protocol correctness**: IPC responses match expected format, WebSocket messages properly validated

3. **Report findings** as:
   - **Critical**: Must fix (security, data loss, crashes)
   - **Warning**: Should fix (performance, reliability)
   - **Suggestion**: Nice to have (readability, patterns)

4. **For each finding**, include:
   - File and line
   - What's wrong
   - How to fix it (concise)

5. Do NOT auto-fix. Present findings to the user first. If they want fixes, use `/fix` command.
