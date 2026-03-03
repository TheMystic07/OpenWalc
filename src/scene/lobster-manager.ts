import * as THREE from "three";
import {
  loadLobsterModel,
  createLobsterInstance,
  crossfadeTo,
  randomIdleClip,
  ACTION_TO_CLIP,
} from "./lobster.js";
import type { LobsterInstance } from "./lobster.js";
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
  currentClip: string;
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
const IDLE_CYCLE_INTERVAL = 5;

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
    this.modelReady = loadLobsterModel();
  }

  /** Append additional obstacles (e.g. from async terrain loading). */
  addObstacles(obs: Obstacle[]): void {
    this.obstacles.push(...obs);
  }

  /** Add or update a lobster from snapshot / join */
  addOrUpdate(profile: AgentProfile, position: AgentPosition): void {
    let entry = this.lobsters.get(profile.agentId);
    if (!entry) {
      // Create a placeholder entry immediately so duplicate calls don't spawn
      // multiple instances. The actual GLTF instance is wired up asynchronously.
      this.modelReady.then(() => {
        // Guard: another addOrUpdate may have already created this entry while
        // we were waiting for the model.
        if (this.lobsters.has(profile.agentId)) return;
        this._createEntry(profile, position);
      });
    } else {
      entry.profile = profile;
      entry.target = { ...position };
      entry.dead = false;
    }
  }

  /** Create a fully initialised LobsterEntry once the GLTF model is ready. */
  private _createEntry(profile: AgentProfile, position: AgentPosition): void {
    const inst = createLobsterInstance(profile.color);
    inst.group.position.set(position.x, position.y, position.z);
    inst.group.rotation.y = position.rotation;
    inst.group.userData.agentId = profile.agentId;

    // Inner combat ring
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

    // Outer ring for double-ring effect
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

    // Establish initial idle clip tracking
    const initialClip = randomIdleClip();
    crossfadeTo(inst, initialClip, 0);

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
      currentClip: initialClip,
      idleVariantTimer: IDLE_CYCLE_INTERVAL,
    };
    this.lobsters.set(profile.agentId, entry);
  }

  /** Update target position for smooth interpolation */
  updatePosition(agentId: string, pos: AgentPosition): void {
    const entry = this.lobsters.get(agentId);
    if (entry) {
      entry.target = { ...pos };
    }
  }

  /** Set current action/animation */
  setAction(agentId: string, action: string): void {
    const entry = this.lobsters.get(agentId);
    if (entry) {
      entry.action = action;
    }
  }

  /** Play a short-lived action without replacing the persistent action state. */
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

  /** Remove a lobster from the scene */
  remove(agentId: string): void {
    const entry = this.lobsters.get(agentId);
    if (entry) {
      // Dispose animation mixer
      entry.instance.mixer.stopAllAction();
      entry.instance.mixer.uncacheRoot(entry.instance.group);

      this.scene.remove(entry.instance.group);
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

  /** Despawn dead agents after a delay */
  despawnDead(agentId: string, delayMs: number = 5000): void {
    const entry = this.lobsters.get(agentId);
    if (!entry) return;

    entry.transientAction = "defeated";
    entry.transientUntil = Date.now() + delayMs;

    // After delay, remove the agent
    setTimeout(() => {
      this.remove(agentId);
    }, delayMs);
  }

  /** Check if an agent has been idle for too long (returns time since last move in ms) */
  getIdleTime(agentId: string, now: number = Date.now()): number | null {
    const entry = this.lobsters.get(agentId);
    if (!entry) return null;

    const dx = entry.target.x - entry.current.x;
    const dz = entry.target.z - entry.current.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // If currently moving, reset idle timer
    if (dist > 0.1) {
      entry.lastMoveTime = now;
      return 0;
    }

    return entry.lastMoveTime ? now - entry.lastMoveTime : null;
  }

  /** Mark all non-moving agents for removal after idle timeout */
  checkIdleTimeout(idleTimeoutMs: number = 60000): string[] {
    const toRemove: string[] = [];
    const now = Date.now();

    for (const [agentId, entry] of this.lobsters) {
      if (entry.dead) continue; // Don't remove dead agents here (handled separately)
      if (entry.lastMoveTime && now - entry.lastMoveTime > idleTimeoutMs) {
        toRemove.push(agentId);
      }
    }

    return toRemove;
  }

  /** Get world position for an agent */
  getPosition(agentId: string): THREE.Vector3 | null {
    const entry = this.lobsters.get(agentId);
    if (!entry) return null;
    return entry.instance.group.position.clone();
  }

  /**
   * Calculate avoidance steering vector to push the lobster away from
   * nearby obstacles (rocks) and other lobsters.
   */
  private getAvoidance(agentId: string, cx: number, cz: number, heading: number): { ax: number; az: number } {
    let ax = 0;
    let az = 0;

    // Avoid rocks
    for (const obs of this.obstacles) {
      const dx = cx - obs.x;
      const dz = cz - obs.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minDist = obs.radius + LOBSTER_RADIUS;

      if (dist < minDist + AVOIDANCE_LOOKAHEAD && dist > 0.01) {
        // Check if obstacle is roughly ahead (within 120 deg cone)
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

    // Avoid other lobsters
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

  /**
   * Determine the desired GLTF clip name for a given entry.
   */
  private resolveClip(entry: LobsterEntry, moving: boolean): string {
    const activeAction = entry.transientAction ?? entry.action;

    if (entry.dead) return "Death";

    if (moving && activeAction !== "guard" && activeAction !== "stunned" && activeAction !== "defeated") {
      if (activeAction === "approach") return "Run";
      if (activeAction === "swim") return "Swim";
      return "Walk";
    }

    const mapped = ACTION_TO_CLIP[activeAction];
    if (mapped) return mapped;

    // Fallback
    if (entry.inCombat) return "Idle_B";
    return "Idle_A";
  }

  /** Per-frame update: turn to face target, avoid obstacles, then walk */
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

      // NaN guard
      if (!isFinite(dx) || !isFinite(dz) || !isFinite(dist)) continue;

      const turnSpeed = 4 * delta;
      const moveSpeed = 3 * delta;
      const arrivedThreshold = 0.15;
      const facingThreshold = 0.25;

      if (dist > arrivedThreshold) {
        // Get avoidance steering
        const { ax, az } = this.getAvoidance(
          entry.profile.agentId,
          entry.current.x,
          entry.current.z,
          entry.current.rotation
        );

        // Blend desired direction with avoidance
        const steerX = dx + ax * delta;
        const steerZ = dz + az * delta;
        const desiredRotation = Math.atan2(steerX, steerZ);

        // Shortest-arc rotation
        let angleDiff = desiredRotation - entry.current.rotation;
        if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        // Turn toward target
        entry.current.rotation += angleDiff * turnSpeed;
        if (entry.current.rotation > Math.PI) entry.current.rotation -= Math.PI * 2;
        if (entry.current.rotation < -Math.PI) entry.current.rotation += Math.PI * 2;

        // Only move forward once roughly facing the direction
        if (Math.abs(angleDiff) < facingThreshold) {
          // Move in facing direction (not directly toward target)
          // This makes the lobster walk forward naturally
          const forwardX = Math.sin(entry.current.rotation);
          const forwardZ = Math.cos(entry.current.rotation);
          const speed = moveSpeed * Math.min(dist, 1); // Slow down near target

          const newX = entry.current.x + forwardX * speed * 5;
          const newZ = entry.current.z + forwardZ * speed * 5;

          // Hard collision check: don't move into obstacles
          if (!this.isBlocked(entry.profile.agentId, newX, newZ)) {
            entry.current.x = newX;
            entry.current.z = newZ;
          } else {
            // Try sliding along the obstacle
            if (!this.isBlocked(entry.profile.agentId, newX, entry.current.z)) {
              entry.current.x = newX;
            } else if (!this.isBlocked(entry.profile.agentId, entry.current.x, newZ)) {
              entry.current.z = newZ;
            }
            // else: fully blocked, stay in place
          }

          entry.current.y += (entry.target.y - entry.current.y) * moveSpeed;

          // Small sediment trail when a lobster is actively moving.
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
        // Already at target -- interpolate to explicit rotation
        let angleDiff = entry.target.rotation - entry.current.rotation;
        if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        entry.current.rotation += angleDiff * turnSpeed;
        entry.trailTimer = 0;
      }

      entry.instance.group.position.set(
        entry.current.x,
        entry.current.y,
        entry.current.z
      );
      entry.instance.group.rotation.y = entry.current.rotation;

      // Combat ring pulse around active fighters.
      if (entry.inCombat && !entry.dead) {
        entry.combatRing.visible = true;
        entry.outerRing.visible = true;
        const pulse = 0.95 + Math.sin(entry.time * 8) * 0.1;
        entry.combatRing.scale.set(pulse, pulse, pulse);
        entry.combatRingMat.opacity = 0.32 + Math.sin(entry.time * 8) * 0.12;

        // Outer ring counter-rotates and pulses offset
        const outerPulse = 0.93 + Math.sin(entry.time * 6 + 1.5) * 0.08;
        entry.outerRing.scale.set(outerPulse, outerPulse, outerPulse);
        entry.outerRingMat.opacity = 0.18 + Math.sin(entry.time * 6 + 1.5) * 0.08;
        entry.outerRing.rotation.z = entry.time * 0.8;
        entry.combatRing.rotation.z = -entry.time * 0.5;

        // Persistent combat sparks make active fights readable even between turns.
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

      // Hit flash — tint the MeshBasicMaterial color toward red on impact.
      const flash = entry.impactPulse;
      for (const mat of entry.instance.materials) {
        if (!(mat instanceof THREE.MeshBasicMaterial)) continue;
        if (flash > 0) {
          mat.color.setHex(0xff6a4d).lerp(new THREE.Color(0xffffff), 1 - flash);
        } else {
          mat.color.setHex(0xffffff);
        }
      }

      // ── Animation dispatch ──────────────────────────────────────────
      const moving = dist > arrivedThreshold;
      const desiredClip = this.resolveClip(entry, moving);

      // Idle variant cycling: when idle and no transient action, cycle between
      // Idle_A / Idle_B / Idle_C every IDLE_CYCLE_INTERVAL seconds.
      if (!moving && !entry.transientAction && !entry.dead && !entry.inCombat) {
        entry.idleVariantTimer -= delta;
        if (entry.idleVariantTimer <= 0) {
          entry.idleVariantTimer = IDLE_CYCLE_INTERVAL;
          const newIdleClip = randomIdleClip();
          if (newIdleClip !== entry.currentClip) {
            crossfadeTo(entry.instance, newIdleClip);
            entry.currentClip = newIdleClip;
          }
        }
      } else {
        // Reset timer so it starts fresh when idle resumes
        entry.idleVariantTimer = IDLE_CYCLE_INTERVAL;
      }

      // Crossfade to the resolved clip if it has changed
      if (desiredClip !== entry.currentClip) {
        crossfadeTo(entry.instance, desiredClip);
        entry.currentClip = desiredClip;
      }

      // Advance the mixer
      entry.instance.mixer.update(delta);
    }

    this.particles?.update(delta);

    // Animate room particles
    const animateFn = this.scene.userData.animateParticles as
      | ((time: number) => void)
      | undefined;
    if (animateFn) {
      animateFn(performance.now() / 1000);
    }
  }

  /** Check if a position would collide with any obstacle or another lobster */
  private isBlocked(agentId: string, x: number, z: number): boolean {
    // Check rocks
    for (const obs of this.obstacles) {
      const dx = x - obs.x;
      const dz = z - obs.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < obs.radius + LOBSTER_RADIUS * 0.5) return true;
    }

    // Check other lobsters
    for (const [id, other] of this.lobsters) {
      if (id === agentId) continue;
      const dx = x - other.current.x;
      const dz = z - other.current.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < LOBSTER_RADIUS * 1.5) return true;
    }

    return false;
  }

  /** Raycast pick: returns agentId of clicked lobster, or null */
  pick(
    event: MouseEvent,
    camera: THREE.Camera,
    domElement: HTMLElement
  ): string | null {
    const rect = domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, camera);

    const meshes: THREE.Mesh[] = [];
    for (const entry of this.lobsters.values()) {
      entry.instance.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          meshes.push(child);
        }
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

  /** Get all current agent IDs */
  getAgentIds(): string[] {
    return Array.from(this.lobsters.keys());
  }
}
