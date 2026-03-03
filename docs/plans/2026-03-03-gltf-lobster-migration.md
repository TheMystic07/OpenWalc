# GLTF Lobster Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace procedural lobster meshes with the GLTF model (`lobsterDownloaded.gltf`) using its 19 skeletal animations, hue-shifted textures for color variation, and 6 new action types.

**Architecture:** Load GLTF once, clone per-agent via `SkeletonUtils.clone()`. Each clone gets its own `AnimationMixer`. Color variation via canvas hue-shift of the shared texture. Crossfade animations at 200ms.

**Tech Stack:** Three.js 0.170, GLTFLoader, SkeletonUtils, AnimationMixer, CanvasTexture

---

### Task 1: Add new action types to server types

**Files:**
- Modify: `server/types.ts:71-77` (ActionMessage interface)
- Modify: `server/index.ts:2249` (help text)
- Modify: `server/index.ts:2264` (actions array)
- Modify: `server/index.ts:2322` (type cast)

**Step 1: Update ActionMessage type**

In `server/types.ts`, change line 74 from:
```typescript
action: "walk" | "idle" | "wave" | "pinch" | "talk" | "dance" | "backflip" | "spin";
```
to:
```typescript
action: "walk" | "idle" | "wave" | "pinch" | "talk" | "dance" | "backflip" | "spin" | "eat" | "sit" | "swim" | "fly" | "roll" | "lay";
```

**Step 2: Update server/index.ts help text and cast**

At line ~2249, update the help text to include the new actions:
```typescript
action: '{"command":"world-action","args":{"agentId":"ID","action":"wave"}}  — wave|dance|idle|pinch|talk|backflip|spin|eat|sit|swim|fly|roll|lay',
```

At line ~2264, update the actions array:
```typescript
actions: ["walk","idle","wave","pinch","talk","dance","backflip","spin","eat","sit","swim","fly","roll","lay"],
```

At line ~2322, update the type cast:
```typescript
action: (a.action ?? "idle") as ActionMessage["action"],
```

**Step 3: Verify types compile**

Run: `npx tsc --noEmit -p tsconfig.server.json`
Expected: No errors

**Step 4: Commit**

```bash
git add server/types.ts server/index.ts
git commit -m "feat: add eat/sit/swim/fly/roll/lay action types"
```

---

### Task 2: Rewrite lobster.ts — GLTF loader + hue-shift textures

**Files:**
- Rewrite: `src/scene/lobster.ts`

**Step 1: Replace entire lobster.ts**

Delete all existing content and replace with the GLTF-based module:

```typescript
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SkeletonUtils } from "three/addons/utils/SkeletonUtils.js";

// ── Shared state ──────────────────────────────────────────────
const MODEL_PATH = "/Models/lobsterDownloaded.gltf";
const TEXTURE_PATH = "/Models/LobsterTexture.png";

let cachedGltf: {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
} | null = null;

let baseTexture: HTMLImageElement | null = null;
const hueTextureCache = new Map<number, THREE.CanvasTexture>();

// ── Animation clip name map ───────────────────────────────────
// Maps our game action names → GLTF clip names.
export const ACTION_TO_CLIP: Record<string, string> = {
  // Agent actions
  idle: "Idle_A",
  walk: "Walk",
  talk: "Clicked",
  pinch: "Attack",
  wave: "Bounce",
  dance: "Bounce",
  backflip: "Jump",
  spin: "Spin",
  eat: "Eat",
  sit: "Sit",
  swim: "Swim",
  fly: "Fly",
  roll: "Roll",
  lay: "Lay",
  // Combat actions
  strike: "Attack",
  guard: "Sit",
  feint: "Fear",
  approach: "Run",
  retreat: "Fear",
  stunned: "Hit",
  victory: "Bounce",
  defeated: "Death",
  combatReady: "Idle_B",
};

// Random idle variations cycled every few seconds.
export const IDLE_VARIANTS = ["Idle_A", "Idle_B", "Idle_C"];

// Clips that should play once (not loop).
const ONCE_CLIPS = new Set([
  "Attack", "Jump", "Death", "Hit", "Clicked", "Sit", "Lay",
]);

/** Pre-load the GLTF model and base texture. Call once at startup. */
export async function loadLobsterModel(): Promise<void> {
  if (cachedGltf) return;

  const loader = new GLTFLoader();
  const [gltf, img] = await Promise.all([
    loader.loadAsync(MODEL_PATH),
    loadImage(TEXTURE_PATH),
  ]);

  cachedGltf = {
    scene: gltf.scene,
    animations: gltf.animations,
  };
  baseTexture = img;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ── Hue-shift texture ─────────────────────────────────────────

/** Convert a hex color string to a hue angle (0-360). */
function colorToHue(color: string): number {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return Math.round(hsl.h * 360);
}

/** Create a hue-shifted texture using canvas filter. */
function createHueShiftedTexture(hueAngle: number): THREE.CanvasTexture {
  const existing = hueTextureCache.get(hueAngle);
  if (existing) return existing;

  const canvas = document.createElement("canvas");
  canvas.width = baseTexture!.width;
  canvas.height = baseTexture!.height;
  const ctx = canvas.getContext("2d")!;

  // Apply hue rotation via CSS filter
  ctx.filter = `hue-rotate(${hueAngle}deg)`;
  ctx.drawImage(baseTexture!, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false; // GLTF convention
  tex.colorSpace = THREE.SRGBColorSpace;
  hueTextureCache.set(hueAngle, tex);
  return tex;
}

// ── Instance creation ─────────────────────────────────────────

export interface LobsterInstance {
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  materials: THREE.Material[];
}

/**
 * Clone the loaded GLTF model for one agent.
 * Returns the group, mixer, action map, and materials list.
 */
export function createLobsterInstance(color: string): LobsterInstance {
  if (!cachedGltf) throw new Error("Call loadLobsterModel() first");

  const cloned = SkeletonUtils.clone(cachedGltf.scene) as THREE.Group;
  cloned.name = "lobster";

  // Scale to match the gameplay footprint (~2.4 units wide).
  // The GLTF model's raw size needs calibration — adjust this value
  // after visual testing. Starting estimate based on the mesh bounds.
  cloned.scale.set(1.8, 1.8, 1.8);

  // Apply hue-shifted texture
  const hue = colorToHue(color);
  const tex = createHueShiftedTexture(hue);

  const materials: THREE.Material[] = [];
  cloned.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = false;
      // Clone material so each agent can have independent emissive flashes
      if (child.material) {
        const mat = (child.material as THREE.MeshStandardMaterial).clone();
        mat.map = tex;
        mat.needsUpdate = true;
        child.material = mat;
        materials.push(mat);
      }
    }
  });

  // Build AnimationMixer and pre-create all actions
  const mixer = new THREE.AnimationMixer(cloned);
  const actions = new Map<string, THREE.AnimationAction>();

  for (const clip of cachedGltf.animations) {
    const action = mixer.clipAction(clip);
    if (ONCE_CLIPS.has(clip.name)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }
    actions.set(clip.name, action);
  }

  return { group: cloned, mixer, actions, materials };
}

/**
 * Crossfade from the current playing action to a new clip.
 * If already playing the target clip, does nothing.
 */
export function crossfadeTo(
  instance: LobsterInstance,
  clipName: string,
  duration = 0.2,
): void {
  const target = instance.actions.get(clipName);
  if (!target) return;

  // Find the currently playing action (highest weight)
  let current: THREE.AnimationAction | null = null;
  for (const action of instance.actions.values()) {
    if (action.isRunning() && action !== target) {
      if (!current || action.getEffectiveWeight() > current.getEffectiveWeight()) {
        current = action;
      }
    }
  }

  // If target is already running at full weight, skip
  if (target.isRunning() && target.getEffectiveWeight() > 0.9) return;

  target.reset();
  target.setEffectiveTimeScale(1);
  target.setEffectiveWeight(1);
  target.play();

  if (current) {
    current.crossFadeTo(target, duration, true);
  }
}

/** Get a random idle variant clip name. */
export function randomIdleClip(): string {
  return IDLE_VARIANTS[Math.floor(Math.random() * IDLE_VARIANTS.length)];
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors (lobster-manager.ts will have errors since it still imports old functions — that's expected, fixed in Task 3)

**Step 3: Commit**

```bash
git add src/scene/lobster.ts
git commit -m "feat: replace procedural lobster with GLTF model loader"
```

---

### Task 3: Rewrite lobster-manager.ts — AnimationMixer integration

**Files:**
- Rewrite: `src/scene/lobster-manager.ts`

**Step 1: Replace entire lobster-manager.ts**

```typescript
import * as THREE from "three";
import {
  loadLobsterModel,
  createLobsterInstance,
  crossfadeTo,
  randomIdleClip,
  ACTION_TO_CLIP,
  type LobsterInstance,
} from "./lobster.js";
import type { AgentProfile, AgentPosition } from "../../server/types.js";
import type { ParticleEngine } from "./particle-engine.js";

interface LobsterEntry {
  instance: LobsterInstance;
  profile: AgentProfile;
  current: AgentPosition;
  target: AgentPosition;
  action: string;
  transientAction: string | null;
  transientUntil: number;
  time: number;
  inCombat: boolean;
  combatRing: THREE.Mesh;
  combatRingMat: THREE.MeshBasicMaterial;
  outerRing: THREE.Mesh;
  outerRingMat: THREE.MeshBasicMaterial;
  impactPulse: number;
  dead: boolean;
  trailTimer: number;
  combatSparkTimer: number;
  lastMoveTime: number;
  /** Current GLTF clip name playing (to avoid redundant crossfades). */
  currentClip: string;
  /** Timer for cycling idle variants. */
  idleVariantTimer: number;
}

interface Obstacle {
  x: number;
  z: number;
  radius: number;
}

const LOBSTER_RADIUS = 1.8;
const AVOIDANCE_LOOKAHEAD = 4;
const AVOIDANCE_FORCE = 6;
const IDLE_CYCLE_INTERVAL = 5; // seconds between random idle switches

export class LobsterManager {
  private scene: THREE.Scene;
  private lobsters = new Map<string, LobsterEntry>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private obstacles: Obstacle[] = [];
  private particles: ParticleEngine | null;
  private modelReady: Promise<void>;

  constructor(scene: THREE.Scene, obstacles?: Obstacle[], particles?: ParticleEngine) {
    this.scene = scene;
    this.obstacles = obstacles ?? [];
    this.particles = particles ?? null;
    // Start loading the model immediately
    this.modelReady = loadLobsterModel();
  }

  addObstacles(obs: Obstacle[]): void {
    this.obstacles.push(...obs);
  }

  /** Add or update a lobster from snapshot / join */
  addOrUpdate(profile: AgentProfile, position: AgentPosition): void {
    let entry = this.lobsters.get(profile.agentId);
    if (!entry) {
      // Queue creation — model may still be loading
      this.modelReady.then(() => {
        // Check again in case it was added while we waited
        if (this.lobsters.has(profile.agentId)) {
          const existing = this.lobsters.get(profile.agentId)!;
          existing.profile = profile;
          existing.target = { ...position };
          existing.dead = false;
          return;
        }
        this._createEntry(profile, position);
      });
    } else {
      entry.profile = profile;
      entry.target = { ...position };
      entry.dead = false;
    }
  }

  private _createEntry(profile: AgentProfile, position: AgentPosition): void {
    const inst = createLobsterInstance(profile.color);
    inst.group.position.set(position.x, position.y, position.z);
    inst.group.rotation.y = position.rotation;
    inst.group.userData.agentId = profile.agentId;

    // Combat rings (same as before)
    const combatRingMat = new THREE.MeshBasicMaterial({
      color: 0xff5d43,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const combatRing = new THREE.Mesh(
      new THREE.RingGeometry(1.7, 2.0, 40),
      combatRingMat,
    );
    combatRing.rotation.x = -Math.PI / 2;
    combatRing.position.set(0, 0.05, 0);
    combatRing.visible = false;
    inst.group.add(combatRing);

    const outerRingMat = new THREE.MeshBasicMaterial({
      color: 0xff8844,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const outerRing = new THREE.Mesh(
      new THREE.RingGeometry(2.2, 2.4, 40),
      outerRingMat,
    );
    outerRing.rotation.x = -Math.PI / 2;
    outerRing.position.set(0, 0.04, 0);
    outerRing.visible = false;
    inst.group.add(outerRing);

    this.scene.add(inst.group);

    // Start with idle animation
    const idleClip = randomIdleClip();
    crossfadeTo(inst, idleClip, 0);

    const entry: LobsterEntry = {
      instance: inst,
      profile,
      current: { ...position },
      target: { ...position },
      action: "idle",
      transientAction: null,
      transientUntil: 0,
      time: 0,
      inCombat: false,
      combatRing,
      combatRingMat,
      outerRing,
      outerRingMat,
      impactPulse: 0,
      dead: false,
      trailTimer: 0,
      combatSparkTimer: 0,
      lastMoveTime: Date.now(),
      currentClip: idleClip,
      idleVariantTimer: Math.random() * IDLE_CYCLE_INTERVAL,
    };
    this.lobsters.set(profile.agentId, entry);
  }

  updatePosition(agentId: string, pos: AgentPosition): void {
    const entry = this.lobsters.get(agentId);
    if (entry) entry.target = { ...pos };
  }

  setAction(agentId: string, action: string): void {
    const entry = this.lobsters.get(agentId);
    if (entry) entry.action = action;
  }

  triggerAction(agentId: string, action: string, durationMs = 650): void {
    const entry = this.lobsters.get(agentId);
    if (!entry || entry.dead) return;
    entry.transientAction = action;
    entry.transientUntil = Date.now() + Math.max(120, durationMs);
  }

  setCombatState(agentId: string, inCombat: boolean): void {
    const entry = this.lobsters.get(agentId);
    if (!entry) return;
    entry.inCombat = inCombat;
    if (!inCombat) {
      entry.combatRing.visible = false;
      entry.combatRingMat.opacity = 0;
      entry.outerRing.visible = false;
      entry.outerRingMat.opacity = 0;
    }
  }

  pulseImpact(agentId: string): void {
    const entry = this.lobsters.get(agentId);
    if (!entry) return;
    entry.impactPulse = 1;
    this.particles?.emit("hit", entry.instance.group.position, { color: entry.profile.color });
    this.particles?.emitRing("hit", entry.instance.group.position);
  }

  setDeadState(agentId: string, dead: boolean): void {
    const entry = this.lobsters.get(agentId);
    if (!entry) return;
    entry.dead = dead;
    if (dead) {
      entry.inCombat = false;
      entry.combatRing.visible = false;
      entry.combatRingMat.opacity = 0;
      entry.outerRing.visible = false;
      entry.outerRingMat.opacity = 0;
      entry.action = "idle";
      entry.transientAction = null;
      entry.transientUntil = 0;
      this.particles?.emit("death", entry.instance.group.position);
      this.particles?.emitRing("death", entry.instance.group.position);
    }
  }

  remove(agentId: string): void {
    const entry = this.lobsters.get(agentId);
    if (entry) {
      this.scene.remove(entry.instance.group);
      entry.instance.mixer.stopAllAction();
      entry.instance.mixer.uncacheRoot(entry.instance.group);
      entry.instance.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      this.lobsters.delete(agentId);
    }
  }

  despawnDead(agentId: string, delayMs: number = 5000): void {
    const entry = this.lobsters.get(agentId);
    if (!entry) return;
    entry.transientAction = "defeated";
    entry.transientUntil = Date.now() + delayMs;
    setTimeout(() => { this.remove(agentId); }, delayMs);
  }

  getIdleTime(agentId: string, now: number = Date.now()): number | null {
    const entry = this.lobsters.get(agentId);
    if (!entry) return null;
    const dx = entry.target.x - entry.current.x;
    const dz = entry.target.z - entry.current.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > 0.1) {
      entry.lastMoveTime = now;
      return 0;
    }
    return entry.lastMoveTime ? now - entry.lastMoveTime : null;
  }

  checkIdleTimeout(idleTimeoutMs: number = 60000): string[] {
    const toRemove: string[] = [];
    const now = Date.now();
    for (const [agentId, entry] of this.lobsters) {
      if (entry.dead) continue;
      if (entry.lastMoveTime && now - entry.lastMoveTime > idleTimeoutMs) {
        toRemove.push(agentId);
      }
    }
    return toRemove;
  }

  getPosition(agentId: string): THREE.Vector3 | null {
    const entry = this.lobsters.get(agentId);
    if (!entry) return null;
    return entry.instance.group.position.clone();
  }

  private getAvoidance(agentId: string, cx: number, cz: number, heading: number): { ax: number; az: number } {
    let ax = 0;
    let az = 0;

    for (const obs of this.obstacles) {
      const dx = cx - obs.x;
      const dz = cz - obs.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minDist = obs.radius + LOBSTER_RADIUS;
      if (dist < minDist + AVOIDANCE_LOOKAHEAD && dist > 0.01) {
        const toObsAngle = Math.atan2(-dx, -dz);
        let relAngle = toObsAngle - heading;
        if (relAngle > Math.PI) relAngle -= Math.PI * 2;
        if (relAngle < -Math.PI) relAngle += Math.PI * 2;
        if (Math.abs(relAngle) < Math.PI * 0.67) {
          const strength = AVOIDANCE_FORCE * (1 - dist / (minDist + AVOIDANCE_LOOKAHEAD));
          ax += (dx / dist) * strength;
          az += (dz / dist) * strength;
        }
      }
    }

    for (const [id, other] of this.lobsters) {
      if (id === agentId) continue;
      const dx = cx - other.current.x;
      const dz = cz - other.current.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minDist = LOBSTER_RADIUS * 2;
      if (dist < minDist + 2 && dist > 0.01) {
        const strength = AVOIDANCE_FORCE * 0.8 * (1 - dist / (minDist + 2));
        ax += (dx / dist) * strength;
        az += (dz / dist) * strength;
      }
    }

    return { ax, az };
  }

  /** Resolve the desired GLTF clip name for the current state. */
  private resolveClip(entry: LobsterEntry, moving: boolean): string {
    const activeAction = entry.transientAction ?? entry.action;

    if (entry.dead) return "Death";

    // Moving agents always show Walk (or Run for approach)
    if (moving && activeAction !== "guard" && activeAction !== "stunned" && activeAction !== "defeated") {
      if (activeAction === "approach") return "Run";
      if (activeAction === "swim") return "Swim";
      return "Walk";
    }

    // Direct mapping from action → clip
    const clip = ACTION_TO_CLIP[activeAction];
    if (clip) return clip;

    // Fallback: combat-ready idle or standard idle
    if (entry.inCombat) return "Idle_B";
    return "Idle_A";
  }

  update(delta: number): void {
    const now = Date.now();
    for (const entry of this.lobsters.values()) {
      entry.time += delta;
      entry.impactPulse = Math.max(0, entry.impactPulse - delta * 3.2);

      if (entry.transientAction && now >= entry.transientUntil) {
        entry.transientAction = null;
      }

      const dx = entry.target.x - entry.current.x;
      const dz = entry.target.z - entry.current.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (!isFinite(dx) || !isFinite(dz) || !isFinite(dist)) continue;

      const turnSpeed = 4 * delta;
      const moveSpeed = 3 * delta;
      const arrivedThreshold = 0.15;
      const facingThreshold = 0.25;

      if (dist > arrivedThreshold) {
        const { ax, az } = this.getAvoidance(
          entry.profile.agentId, entry.current.x, entry.current.z, entry.current.rotation
        );
        const steerX = dx + ax * delta;
        const steerZ = dz + az * delta;
        const desiredRotation = Math.atan2(steerX, steerZ);

        let angleDiff = desiredRotation - entry.current.rotation;
        if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        entry.current.rotation += angleDiff * turnSpeed;
        if (entry.current.rotation > Math.PI) entry.current.rotation -= Math.PI * 2;
        if (entry.current.rotation < -Math.PI) entry.current.rotation += Math.PI * 2;

        if (Math.abs(angleDiff) < facingThreshold) {
          const forwardX = Math.sin(entry.current.rotation);
          const forwardZ = Math.cos(entry.current.rotation);
          const speed = moveSpeed * Math.min(dist, 1);
          const newX = entry.current.x + forwardX * speed * 5;
          const newZ = entry.current.z + forwardZ * speed * 5;

          if (!this.isBlocked(entry.profile.agentId, newX, newZ)) {
            entry.current.x = newX;
            entry.current.z = newZ;
          } else {
            if (!this.isBlocked(entry.profile.agentId, newX, entry.current.z)) {
              entry.current.x = newX;
            } else if (!this.isBlocked(entry.profile.agentId, entry.current.x, newZ)) {
              entry.current.z = newZ;
            }
          }
          entry.current.y += (entry.target.y - entry.current.y) * moveSpeed;

          entry.trailTimer -= delta;
          if (entry.trailTimer <= 0) {
            entry.trailTimer = 0.14 + Math.random() * 0.12;
            this.particles?.emit("trail", entry.instance.group.position, {
              color: new THREE.Color(entry.profile.color).lerp(new THREE.Color(0xffffff), 0.4),
              rotation: entry.current.rotation,
            });
          }
        }
      } else {
        let angleDiff = entry.target.rotation - entry.current.rotation;
        if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        entry.current.rotation += angleDiff * turnSpeed;
        entry.trailTimer = 0;
      }

      entry.instance.group.position.set(entry.current.x, entry.current.y, entry.current.z);
      entry.instance.group.rotation.y = entry.current.rotation;

      // Combat ring visuals (unchanged logic)
      if (entry.inCombat && !entry.dead) {
        entry.combatRing.visible = true;
        entry.outerRing.visible = true;
        const pulse = 0.95 + Math.sin(entry.time * 8) * 0.1;
        entry.combatRing.scale.set(pulse, pulse, pulse);
        entry.combatRingMat.opacity = 0.32 + Math.sin(entry.time * 8) * 0.12;
        const outerPulse = 0.93 + Math.sin(entry.time * 6 + 1.5) * 0.08;
        entry.outerRing.scale.set(outerPulse, outerPulse, outerPulse);
        entry.outerRingMat.opacity = 0.18 + Math.sin(entry.time * 6 + 1.5) * 0.08;
        entry.outerRing.rotation.z = entry.time * 0.8;
        entry.combatRing.rotation.z = -entry.time * 0.5;
        entry.combatSparkTimer -= delta;
        if (entry.combatSparkTimer <= 0) {
          entry.combatSparkTimer = 0.07 + Math.random() * 0.05;
          this.particles?.emit("spark", entry.instance.group.position);
        }
      } else {
        entry.combatRing.visible = false;
        entry.outerRing.visible = false;
        entry.combatSparkTimer = 0;
      }

      // Hit flash on materials
      const flash = entry.impactPulse;
      for (const mat of entry.instance.materials) {
        if (!("emissive" in mat) || !("emissiveIntensity" in mat)) continue;
        const emMat = mat as THREE.MeshStandardMaterial;
        emMat.emissive.setHex(0xff6a4d);
        emMat.emissiveIntensity = flash * 0.85;
      }

      // ── Animation dispatch ────────────────────────────────
      const moving = dist > arrivedThreshold;
      const desiredClip = this.resolveClip(entry, moving);

      // Random idle variant cycling
      if (desiredClip.startsWith("Idle_") && !entry.transientAction && entry.action === "idle") {
        entry.idleVariantTimer -= delta;
        if (entry.idleVariantTimer <= 0) {
          entry.idleVariantTimer = IDLE_CYCLE_INTERVAL + Math.random() * 3;
          const variant = randomIdleClip();
          if (variant !== entry.currentClip) {
            crossfadeTo(entry.instance, variant, 0.4);
            entry.currentClip = variant;
          }
        }
      }

      // Switch clip if different from what's currently playing
      if (desiredClip !== entry.currentClip) {
        crossfadeTo(entry.instance, desiredClip);
        entry.currentClip = desiredClip;
        entry.idleVariantTimer = IDLE_CYCLE_INTERVAL + Math.random() * 3;
      }

      // Advance the mixer
      entry.instance.mixer.update(delta);
    }

    this.particles?.update(delta);

    const animateFn = this.scene.userData.animateParticles as
      | ((time: number) => void)
      | undefined;
    if (animateFn) {
      animateFn(performance.now() / 1000);
    }
  }

  private isBlocked(agentId: string, x: number, z: number): boolean {
    for (const obs of this.obstacles) {
      const dx = x - obs.x;
      const dz = z - obs.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < obs.radius + LOBSTER_RADIUS * 0.5) return true;
    }
    for (const [id, other] of this.lobsters) {
      if (id === agentId) continue;
      const dx = x - other.current.x;
      const dz = z - other.current.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < LOBSTER_RADIUS * 1.5) return true;
    }
    return false;
  }

  pick(event: MouseEvent, camera: THREE.Camera, domElement: HTMLElement): string | null {
    const rect = domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, camera);

    const meshes: THREE.Mesh[] = [];
    for (const entry of this.lobsters.values()) {
      entry.instance.group.traverse((child) => {
        if (child instanceof THREE.Mesh) meshes.push(child);
      });
    }

    const intersects = this.raycaster.intersectObjects(meshes, false);
    if (intersects.length > 0) {
      let obj: THREE.Object3D | null = intersects[0].object;
      while (obj) {
        if (obj.userData.agentId) return obj.userData.agentId as string;
        obj = obj.parent;
      }
    }
    return null;
  }

  getAgentIds(): string[] {
    return Array.from(this.lobsters.keys());
  }
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/scene/lobster-manager.ts
git commit -m "feat: integrate AnimationMixer and GLTF clips into LobsterManager"
```

---

### Task 4: Update main.ts for async model preload

**Files:**
- Modify: `src/main.ts:62` (LobsterManager constructor area)

**Step 1: Add model preload import and call**

At the top of main.ts, add the import:
```typescript
import { loadLobsterModel } from "./scene/lobster.js";
```

The `LobsterManager` constructor already calls `loadLobsterModel()` internally, but for a better loading experience, we can kick off the preload immediately alongside scene setup. After line 56 (after `createScene()`), add:
```typescript
// Kick off GLTF lobster model load early (LobsterManager awaits this internally)
loadLobsterModel().catch((err) => console.warn("[main] Lobster model load failed:", err));
```

This ensures the model starts loading before terrain and buildings resolve, so lobsters appear faster.

**Step 2: Verify it compiles and runs**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npm run dev`
Expected: Dev server starts, world loads, lobsters render with the GLTF model

**Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: preload GLTF lobster model at startup"
```

---

### Task 5: Visual tuning and scale calibration

**Files:**
- Modify: `src/scene/lobster.ts` (scale value)

**Step 1: Open the world in browser**

Navigate to `http://localhost:3000/world.html` and observe the lobster model size relative to the terrain, buildings, and combat rings.

**Step 2: Adjust scale**

The initial scale is `1.8` in `createLobsterInstance()`. Tune this value up or down until the lobster fits the same footprint as the old procedural lobster (~2.4 units across). The combat rings at 1.7-2.4 inner/outer radius should visually wrap the model.

Also check:
- `tex.flipY` — GLTF usually expects `false`, but verify the texture isn't upside-down
- Shadow rendering — lobster should cast ground shadows
- Hue shifting — different agent colors should produce distinctly colored lobsters

**Step 3: Commit final scale**

```bash
git add src/scene/lobster.ts
git commit -m "fix: calibrate GLTF lobster scale and texture orientation"
```

---

### Task 6: Update skill documentation

**Files:**
- Modify: `skills/openclaw-world-agent/SKILL.md`
- Modify: `skills/world-room/SKILL.md`

**Step 1: Add new actions to skill docs**

Find the section listing available actions and add `eat`, `sit`, `swim`, `fly`, `roll`, `lay` with descriptions.

**Step 2: Commit**

```bash
git add skills/
git commit -m "docs: add new action types to skill documentation"
```

---

### Task 7: Run full verification

**Step 1: Type check server**

Run: `npx tsc --noEmit -p tsconfig.server.json`
Expected: No errors

**Step 2: Type check frontend**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Visual verification**

Run: `npm run dev`
Navigate to `http://localhost:3000/world.html`
Verify:
- Lobsters render as GLTF models (not spheres/cylinders)
- Different colors via hue-shifted textures
- Walking animation plays when moving
- Idle animations cycle between A/B/C variants
- Combat animations play during battles
- Death animation plays on KO
- Hit flash still works
- Combat rings still pulse
- Particles still emit
- Labels/bubbles still anchor correctly (CSS2DRenderer finds `name === "lobster"`)
