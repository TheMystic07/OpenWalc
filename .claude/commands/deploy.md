---
description: Build production bundle and verify it's ready to deploy.
allowed-tools: Bash, Read, Glob
---

# Production Build & Deploy Check

## Steps

1. Run `npm run build` to produce both `dist/` (frontend) and `dist-server/` (server)

2. Verify outputs exist:
   - `dist/index.html` (landing)
   - `dist/world.html` (3D world)
   - `dist/admin.html` (admin panel)
   - `dist-server/index.js` (server entry)

3. Report build sizes:
   - `du -sh dist/` and `du -sh dist-server/`
   - Largest JS bundles in `dist/assets/`

4. Check for common issues:
   - Any TypeScript errors during build
   - Missing environment variables in `.env.example` vs code references

5. If `$ARGUMENTS` includes "start", also run `npm start` and verify the server starts on port 18800.
