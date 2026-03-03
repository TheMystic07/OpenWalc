---
description: Delegate a coding task to Codex. Claude plans, Codex codes, Claude reviews.
argument-hint: add a /room-list REST endpoint that returns all active rooms
allowed-tools: Read, Glob, Grep, Bash, Edit, Write, Task, mcp__codex
---

# Implement via Codex

You are the **orchestrator**. You plan and review. Codex writes the code.

## Workflow

1. **Understand the request**: Read `$ARGUMENTS` and identify what needs to change.

2. **Gather context**: Read the relevant files. For this project:
   - Server code lives in `server/` (TypeScript, Node.js, ws)
   - Frontend code lives in `src/` (TypeScript, Three.js, Vite)
   - Shared types in `server/types.ts`
   - Styles in `src/style.css`
   - Tests in `server/__tests__/`

3. **Create a plan**: Write a concise plan of what files to create/modify and what changes to make. Show the plan to the user.

4. **Delegate to Codex**: Use the Codex MCP tools to have Codex write the actual code. Give Codex:
   - The specific file paths to modify
   - The exact changes needed (what to add/change/remove)
   - Relevant context from files you've read
   - The project conventions (see CLAUDE.md)

5. **Review**: After Codex writes code, review the output:
   - Run `npx tsc --noEmit -p tsconfig.server.json` for server changes
   - Run `npx tsc --noEmit` for frontend changes
   - Run `npm test` if tests are affected
   - Check the code follows project patterns (discriminated unions, IPC protocol, etc.)

6. **Iterate**: If there are issues, send Codex targeted fix instructions. Don't rewrite it yourself.

## Project Conventions to Enforce
- All world events use `worldType` discriminator field
- IPC commands return `{ok, data?, error?}`
- Rate limiting and bounds checking in command-queue
- AOI filtering for client data
- Console log prefixes: `[module-name]`
- Dark theme (#0d1117) for any CSS
