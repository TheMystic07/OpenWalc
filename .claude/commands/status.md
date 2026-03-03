---
description: Quick project status — git, running processes, and recent changes.
allowed-tools: Bash
---

# Project Status

Quick snapshot of the project state.

## Steps

1. Run these **in parallel**:
   - `git status --short` — uncommitted changes
   - `git log --oneline -5` — recent commits
   - `curl -s http://localhost:18800/health 2>/dev/null || echo "Server not running"` — server health

2. Summarize in a compact table:
   - Git: branch name, number of changed files, untracked count
   - Server: running or not, if running show uptime/agent count from health response
   - Recent: last 3 commit messages (one-liner each)

3. Keep it brief. No explanations unless something looks wrong.
