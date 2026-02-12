import * as THREE from "three";
import {
  createLobster,
  animateIdle,
  animateWalk,
  animateClawSnap,
  animateWave,
  animateDance,
  animateBackflip,
  animateSpin,
} from "./lobster.js";
import type { AgentProfile, AgentPosition } from "../../server/types.js";

interface LobsterEntry {
  group: THREE.Group;
  profile: AgentProfile;
  current: AgentPosition;
  target: AgentPosition;
  action: string;
  time: number;
  inCombat: boolean;
  combatRing: THREE.Mesh;
  combatRingMat: THREE.MeshBasicMaterial;
  impactPulse: number;
  dead: boolean;
  materials: THREE.Material[];
  trailTimer: number;
  combatSparkTimer: number;
}

interface Obstacle {
  x: number;
  z: number;
  radius: number;
}

interface WorldParticle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  drag: number;
  gravity: number;
}

interface RingPulse {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  growSpeed: number;
}

const LOBSTER_RADIUS = 1.8;
const AVOIDANCE_LOOKAHEAD = 4;
const AVOIDANCE_FORCE = 6;

export class LobsterManager {
  private scene: THREE.Scene;
  private lobsters = new Map<string, LobsterEntry>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private obstacles: Obstacle[] = [];
  private particles: WorldParticle[] = [];
  private ringPulses: RingPulse[] = [];
  private particleGeometry = new THREE.IcosahedronGeometry(0.11, 0);
  private trailGeometry = new THREE.SphereGeometry(0.08, 8, 6);
  private ringGeometry = new THREE.RingGeometry(0.5, 0.68, 28);

  constructor(scene: THREE.Scene, obstacles?: Obstacle[]) {
    this.scene = scene;
    this.obstacles = obstacles ?? [];
  }

  /** Append additional obstacles (e.g. from async terrain loading). */
  addObstacles(obs: Obstacle[]): void {
    this.obstacles.push(...obs);
  }

  /** Add or update a lobster from snapshot / join */
  addOrUpdate(profile: AgentProfile, position: AgentPosition): void {
    let entry = this.lobsters.get(profile.agentId);
    if (!entry) {
      const group = createLobster(profile.color);
      group.position.set(position.x, position.y, position.z);
      group.rotation.y = position.rotation;
      group.userData.agentId = profile.agentId;

      const combatRingMat = new THREE.MeshBasicMaterial({
        color: 0xff5d43,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const combatRing = new THREE.Mesh(
        new THREE.RingGeometry(1.7, 2.15, 28),
        combatRingMat,
      );
      combatRing.rotation.x = -Math.PI / 2;
      combatRing.position.set(0, 0.05, 0);
      combatRing.visible = false;
      group.add(combatRing);

      const materials: THREE.Material[] = [];
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        if (Array.isArray(child.material)) {
          for (const mat of child.material) materials.push(mat);
        } else {
          materials.push(child.material);
        }
      });

      this.scene.add(group);

      entry = {
        group,
        profile,
        current: { ...position },
        target: { ...position },
        action: "idle",
        time: 0,
        inCombat: false,
        combatRing,
        combatRingMat,
        impactPulse: 0,
        dead: false,
        materials,
        trailTimer: 0,
        combatSparkTimer: 0,
      };
      this.lobsters.set(profile.agentId, entry);
    } else {
      entry.profile = profile;
      entry.target = { ...position };
      entry.dead = false;
    }
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

  setCombatState(agentId: string, inCombat: boolean): void {
    const entry = this.lobsters.get(agentId);
    if (!entry) return;
    entry.inCombat = inCombat;
    if (!inCombat) {
      entry.combatRing.visible = false;
      entry.combatRingMat.opacity = 0;
    }
  }

  pulseImpact(agentId: string): void {
    const entry = this.lobsters.get(agentId);
    if (!entry) return;
    entry.impactPulse = 1;
    this.spawnHitBurst(entry.group.position, entry.profile.color, 10, 2.7);
    this.spawnRingPulse(entry.group.position, 0xff9168, 0.42, 3.4);
  }

  setDeadState(agentId: string, dead: boolean): void {
    const entry = this.lobsters.get(agentId);
    if (!entry) return;
    entry.dead = dead;
    if (dead) {
      entry.inCombat = false;
      entry.combatRing.visible = false;
      entry.combatRingMat.opacity = 0;
      entry.action = "idle";
      this.spawnHitBurst(entry.group.position, 0xff4d4d, 28, 3.4, 1.1, 0.18);
      this.spawnRingPulse(entry.group.position, 0xff4d4d, 0.9, 5.2);
    }
  }

  /** Remove a lobster from the scene */
  remove(agentId: string): void {
    const entry = this.lobsters.get(agentId);
    if (entry) {
      this.scene.remove(entry.group);
      entry.group.traverse((child) => {
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

  /** Get world position for an agent */
  getPosition(agentId: string): THREE.Vector3 | null {
    const entry = this.lobsters.get(agentId);
    if (!entry) return null;
    return entry.group.position.clone();
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
        // Check if obstacle is roughly ahead (within 120° cone)
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

  /** Per-frame update: turn to face target, avoid obstacles, then walk */
  update(delta: number): void {
    for (const entry of this.lobsters.values()) {
      entry.time += delta;
      entry.impactPulse = Math.max(0, entry.impactPulse - delta * 3.2);

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

          let newX = entry.current.x + forwardX * speed * 5;
          let newZ = entry.current.z + forwardZ * speed * 5;

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

          animateWalk(entry.group, entry.time);

          // Small sediment trail when a lobster is actively moving.
          entry.trailTimer -= delta;
          if (entry.trailTimer <= 0) {
            entry.trailTimer = 0.14 + Math.random() * 0.12;
            this.spawnTrailPuff(entry.group.position, entry.current.rotation, entry.profile.color);
          }
        }
      } else {
        // Already at target — interpolate to explicit rotation
        let angleDiff = entry.target.rotation - entry.current.rotation;
        if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        entry.current.rotation += angleDiff * turnSpeed;
        entry.trailTimer = 0;
      }

      entry.group.position.set(
        entry.current.x,
        entry.current.y,
        entry.current.z
      );
      entry.group.rotation.y = entry.current.rotation;

      // Combat ring pulse around active fighters.
      if (entry.inCombat && !entry.dead) {
        entry.combatRing.visible = true;
        const pulse = 0.95 + Math.sin(entry.time * 10) * 0.12;
        entry.combatRing.scale.set(pulse, pulse, pulse);
        entry.combatRingMat.opacity = 0.28 + Math.sin(entry.time * 10) * 0.1;

        // Persistent combat sparks make active fights readable even between turns.
        entry.combatSparkTimer -= delta;
        if (entry.combatSparkTimer <= 0) {
          entry.combatSparkTimer = 0.09 + Math.random() * 0.06;
          this.spawnCombatSpark(entry.group.position);
        }
      } else {
        entry.combatRing.visible = false;
        entry.combatSparkTimer = 0;
      }

      // Hit flash makes active exchanges readable at a glance.
      const flash = entry.impactPulse;
      for (const mat of entry.materials) {
        if (!("emissive" in mat) || !("emissiveIntensity" in mat)) continue;
        const emMat = mat as THREE.MeshToonMaterial;
        emMat.emissive.setHex(0xff6a4d);
        emMat.emissiveIntensity = flash * 0.85;
      }

      // Run action animation when arrived
      const t = entry.time;
      if (dist <= arrivedThreshold) {
        switch (entry.action) {
          case "walk":
            animateWalk(entry.group, t);
            animateIdle(entry.group, t);
            break;
          case "talk":
          case "pinch":
            animateClawSnap(entry.group, t);
            animateIdle(entry.group, t);
            break;
          case "wave":
            animateWave(entry.group, t);
            animateIdle(entry.group, t);
            break;
          case "dance":
            animateDance(entry.group, t);
            break;
          case "backflip":
            animateBackflip(entry.group, t);
            break;
          case "spin":
            animateSpin(entry.group, t);
            break;
          case "idle":
          default:
            animateIdle(entry.group, t);
            break;
        }
      } else {
        animateIdle(entry.group, t);
      }
    }

    this.updateParticles(delta);

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
      entry.group.traverse((child) => {
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

  private spawnTrailPuff(position: THREE.Vector3, rotation: number, color: string): void {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.4),
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.trailGeometry, mat);

    const backward = new THREE.Vector3(Math.sin(rotation + Math.PI), 0, Math.cos(rotation + Math.PI));
    const side = new THREE.Vector3(-backward.z, 0, backward.x).multiplyScalar((Math.random() - 0.5) * 0.55);
    mesh.position.copy(position).add(backward.multiplyScalar(0.9)).add(side);
    mesh.position.y = 0.16 + Math.random() * 0.12;
    this.scene.add(mesh);

    const vel = new THREE.Vector3((Math.random() - 0.5) * 0.35, 0.42 + Math.random() * 0.2, (Math.random() - 0.5) * 0.35);
    this.particles.push({
      mesh,
      velocity: vel,
      life: 0.58,
      maxLife: 0.58,
      drag: 0.9,
      gravity: 1.1,
    });
  }

  private spawnHitBurst(
    position: THREE.Vector3,
    color: string | number,
    count: number,
    speed: number,
    life = 0.7,
    scale = 0.14,
  ): void {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.particleGeometry, mat);
      mesh.scale.setScalar(scale * (0.8 + Math.random() * 0.65));
      mesh.position.copy(position);
      mesh.position.y += 0.75 + Math.random() * 0.7;
      this.scene.add(mesh);

      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * speed,
        0.8 + Math.random() * speed * 0.45,
        (Math.random() - 0.5) * speed,
      );

      this.particles.push({
        mesh,
        velocity: vel,
        life,
        maxLife: life,
        drag: 0.84,
        gravity: 4.2,
      });
    }
  }

  private spawnCombatSpark(position: THREE.Vector3): void {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffa347,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.particleGeometry, mat);
    mesh.scale.setScalar(0.115 + Math.random() * 0.055);

    const angle = Math.random() * Math.PI * 2;
    const radius = 0.9 + Math.random() * 0.75;
    mesh.position.set(
      position.x + Math.cos(angle) * radius,
      0.45 + Math.random() * 0.65,
      position.z + Math.sin(angle) * radius,
    );
    this.scene.add(mesh);

    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * 0.55,
      0.95 + Math.random() * 0.5,
      (Math.random() - 0.5) * 0.55,
    );

    this.particles.push({
      mesh,
      velocity: vel,
      life: 0.45,
      maxLife: 0.45,
      drag: 0.86,
      gravity: 3.1,
    });
  }

  private spawnRingPulse(position: THREE.Vector3, color: number, life = 0.45, growSpeed = 3.8): void {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.ringGeometry, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(position.x, 0.08, position.z);
    mesh.scale.setScalar(0.65);
    this.scene.add(mesh);

    this.ringPulses.push({
      mesh,
      life,
      maxLife: life,
      growSpeed,
    });
  }

  private updateParticles(delta: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= delta;

      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
        continue;
      }

      p.velocity.y -= p.gravity * delta;
      const drag = Math.pow(p.drag, delta * 60);
      p.velocity.multiplyScalar(drag);
      p.mesh.position.addScaledVector(p.velocity, delta);
      p.mesh.scale.multiplyScalar(0.986);

      const mat = p.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 0.9 * (p.life / p.maxLife));
    }

    for (let i = this.ringPulses.length - 1; i >= 0; i--) {
      const ring = this.ringPulses[i];
      ring.life -= delta;

      if (ring.life <= 0) {
        this.scene.remove(ring.mesh);
        (ring.mesh.material as THREE.Material).dispose();
        this.ringPulses.splice(i, 1);
        continue;
      }

      ring.mesh.scale.addScalar(delta * ring.growSpeed);
      const mat = ring.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.5 * (ring.life / ring.maxLife);
    }
  }
}
