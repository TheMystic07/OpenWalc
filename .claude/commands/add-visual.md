---
description: Add a visual feature to the 3D world (animation, effect, UI element). Claude designs, Codex implements.
argument-hint: add a healing particle effect when an agent uses guard in combat
allowed-tools: Read, Glob, Grep, Bash, Edit, Write, Task, mcp__codex
---

# Add Visual Feature

Claude designs the visual. Codex implements in Three.js / CSS.

## Workflow

1. **Understand the request**: Read `$ARGUMENTS`. Determine what kind of visual:
   - **3D effect** → `src/scene/particle-engine.ts` or `src/scene/effects.ts`
   - **Animation** → `src/scene/lobster-manager.ts` (animation state machine)
   - **UI element** → `src/ui/` files + `src/style.css`
   - **Building/object** → `src/scene/buildings.ts`
   - **Terrain** → `src/scene/terrain.ts`

2. **Read existing code** to understand current patterns:
   - Particle effects use `ParticleEngine` class with spawn/update/dispose cycle
   - Lobster animations are state-driven: `walk`, `idle`, `dance`, `strike`, `guard`, etc.
   - UI uses DOM overlays via CSS2DRenderer for in-world labels, regular DOM for panels
   - Style uses dark theme (#0d1117 bg, #e6edf3 text)
   - MeshToonMaterial for cartoon aesthetic

3. **Design the visual**: Describe what it looks like, how it triggers, how it integrates.

4. **Delegate to Codex**: Give it:
   - The specific file(s) to modify
   - The Three.js / CSS approach to use
   - How it hooks into existing systems (e.g., battle events trigger effects)

5. **Verify**:
   - `npx tsc --noEmit` (frontend type check)
   - Manual visual check by running `npm run dev` and viewing `localhost:3000/world.html`

## Three.js Patterns in This Project
- Scene setup in `src/scene/room.ts`
- Toon shading with `MeshToonMaterial`
- CSS2DRenderer for floating labels/bubbles
- PointLight shadows (PCF soft)
- Fog + ACES Filmic tone mapping
- OrbitControls with damping
