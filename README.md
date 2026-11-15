# ZAAPworld — Aether Sanctuary

A mobile-first 3D open-field exploration game built with **PlayCanvas**, **TypeScript**, **Vite**, **Blender 5.3** GLB assets, and a **Node.js WebSocket** real-time co-op server (`15 Hz` authoritative snapshots, up to **3 players** per room).

## Features

- **3D Open-Field Sanctuary (`240m × 240m`)**: Procedural analytical terrain heightfield with emerald meadow, sparkling crystal lake (`y = 0`), winding paths, elevated Ancient Ruin Sanctuary plateau, perimeter mountain ridges, and 12 collectible Vital Crystals.
- **3-Player Real-Time Co-op (`Phase 2`)**:
  - Room creation, 6-character shareable room codes (`?room=CODE` invite links), and 3 color-coded explorer slots (`Azure`, `Solar`, `Nova`).
  - Client-side prediction + `15 Hz` server-authoritative snapshots (`server/index.mjs`) with island boundary (`r <= 108.5m`), analytical terrain height clamping, speed validation, and smooth reconciliation.
  - Remote player snapshot interpolation (`100ms` buffer), GLB/procedural locomotion animations, and projected 3D nameplates.
  - Shared crystal collection state (`crystal_collected`), duplicate-session handoff (`4001`), `25s` reconnect grace period, and exponential-backoff auto-reconnect.
- **Mobile Landscape Multi-Touch HUD & Desktop Controls**:
  - Simultaneous left-thumb virtual joystick + right-thumb camera orbit + Jump/Sprint/Interact touch buttons, plus `WASD`/Arrows, `Shift`, `Space`, `E`/`F`, Mouse drag/PointerLock, and Scroll zoom.
  - Compact Co-op status pill & glassmorphic party modal with live `RTT`, `KB/s`, and party roster.
- **Dynamic Quality & Telemetry (`src/systems/QualityManager.ts`)**:
  - `Auto` / `Low` / `Medium` / `High` presets scaling pixel ratio, shadows, draw distance, LOD bias, and instanced grass.

## Local Setup & Commands

The project includes a portable Node.js `v22.14.0` setup under `.tools/node/` (gitignored).

```powershell
# Add portable Node to PATH for the current PowerShell session
$env:PATH = "c:\ZAAPworld\.tools\node;$env:PATH"

# Install dependencies
npm install

# Typecheck
npm run typecheck

# Development mode (run server + Vite proxy in two terminals)
npm run server   # Starts Node HTTP + WebSocket server on :3001
npm run dev      # Starts Vite on :5173 proxying /ws and /health -> :3001

# Production build & unified server
npm run build
npm start        # Serves dist/ + /ws + /health on :3001
```

## Render Deployment

`render.yaml` deploys a single Node.js Web Service (`zaapworld`) that builds the Vite client (`npm install && npm run build`) and runs `npm start` (`node server/index.mjs`) to serve both static assets (`dist/`, `/models/*.glb` with `model/gltf-binary`) and `/ws` WebSockets with `healthCheckPath: /health`.

## Project Layout

- `server/index.mjs` — Node.js HTTP static server (`/health`, `dist/`, `/models/*`) + `15 Hz` WebSocket room authority (`/ws`).
- `src/shared/NetworkProtocol.ts` — Shared `PROTOCOL_VERSION = 2` messages, `SLOT_PALETTE`, `PlayerSyncState`, and `CoopSessionStatus` contracts.
- `src/network/MultiplayerClient.ts` — Browser WebSocket client, prediction ring buffer, RTT/bandwidth metrics, reconnect backoff, and network simulator.
- `src/network/RemotePlayerManager.ts` — Remote 3D explorer rendering, snapshot interpolation, and screen-projected nameplates.
- `src/systems/ExpansionHooks.ts` — Co-op client (`MultiplayerClient`) plus Phase 3 monster capture & base building hooks.
- `src/types/interfaces.ts` — Shared engine, physics, input, and quality contracts.
- `src/physics/CollisionWorld.ts` — Analytical terrain heightfield, spatial hash colliders, sphere movement, and camera raycasting.
- `src/world/TerrainBuilder.ts` & `src/world/EnvironmentManager.ts` — Terrain, water, sky dome, props, synced crystals, and instanced grass.
- `src/input/InputManager.ts`, `src/player/PlayerController.ts`, `src/camera/ThirdPersonCamera.ts`, `src/ui/HudOverlay.ts`, `src/main.ts` — Input, player locomotion/reconciliation, camera, HUD, and bootstrap.
- `render.yaml` & `server/schema.sql` — Render hosting blueprint and PostgreSQL schema.
