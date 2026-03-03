---
description: Audit Three.js scene and server performance hotspots.
allowed-tools: Bash, Read, Grep, Glob
---

# Performance Audit

Scan the codebase for common performance pitfalls in Three.js and the game server.

## Steps

1. **Three.js scene** — Search for these patterns:
   - Allocations inside render/animation loops (`new Vector3`, `new Color`, `new Matrix4` etc. inside `update`/`animate`/`tick` functions)
   - Missing `.dispose()` calls on removed geometries/materials/textures
   - Unbounded arrays (event logs, particle arrays without cleanup)
   - Large texture sizes or uncompressed assets

2. **Server tick loop** — Check `server/game-loop.ts` and `server/world-state.ts` for:
   - O(n²) agent-to-agent checks that could use the spatial index
   - JSON.stringify in hot paths (snapshot building)
   - Unnecessary deep copies or spread operators in the tick

3. **WebSocket** — Check `server/ws-bridge.ts` and `src/net/ws-client.ts`:
   - Message frequency (are snapshots too frequent?)
   - Large payloads (full state vs delta updates)
   - Missing message batching opportunities

4. **Report findings** as a prioritized list:
   - 🔴 Critical (causes frame drops or memory leaks)
   - 🟡 Warning (suboptimal but not immediately harmful)
   - 🟢 Fine (checked, no issues found)

5. For each issue, suggest a one-line fix or link to the file:line.
