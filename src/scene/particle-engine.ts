import * as THREE from "three";

// ── Preset configuration types ──────────────────────────────────

export interface ParticlePreset {
  count: number;
  color: THREE.ColorRepresentation;
  speed: [number, number];
  life: number;
  gravity: number;
  drag: number;
  scale: number;
  opacity: number;
  scaleFade: number;
  geometry: "icosahedron" | "sphere";
  yOffset: [number, number];
  /** If true, particles spawn behind the rotation direction */
  directional?: boolean;
}

export interface RingPreset {
  color: THREE.ColorRepresentation;
  life: number;
  growSpeed: number;
  startScale: number;
  opacity: number;
}

export interface EmitOptions {
  count?: number;
  color?: THREE.ColorRepresentation;
  life?: number;
  speed?: [number, number];
  scale?: number;
  /** Rotation for directional effects (trail puff facing) */
  rotation?: number;
}

// ── Built-in presets (matching original lobster-manager visuals) ─

const PRESETS: Record<string, ParticlePreset> = {
  trail: {
    count: 1,
    color: 0xffffff,
    speed: [0.35, 0.55],
    life: 0.58,
    gravity: 1.1,
    drag: 0.9,
    scale: 1.0,
    opacity: 0.22,
    scaleFade: 0.986,
    geometry: "sphere",
    yOffset: [0.16, 0.28],
    directional: true,
  },
  hit: {
    count: 16,
    color: 0xff5533,
    speed: [2.2, 3.2],
    life: 0.8,
    gravity: 3.8,
    drag: 0.85,
    scale: 0.16,
    opacity: 0.92,
    scaleFade: 0.984,
    geometry: "icosahedron",
    yOffset: [0.6, 1.6],
  },
  death: {
    count: 40,
    color: 0xff3333,
    speed: [2.8, 4.0],
    life: 1.3,
    gravity: 3.5,
    drag: 0.83,
    scale: 0.2,
    opacity: 0.9,
    scaleFade: 0.984,
    geometry: "icosahedron",
    yOffset: [0.5, 1.8],
  },
  spark: {
    count: 1,
    color: 0xffa347,
    speed: [0.55, 1.0],
    life: 0.45,
    gravity: 3.1,
    drag: 0.86,
    scale: 0.14,
    opacity: 0.72,
    scaleFade: 0.986,
    geometry: "icosahedron",
    yOffset: [0.45, 1.1],
  },
  slash: {
    count: 18,
    color: 0xffcc44,
    speed: [2.0, 3.0],
    life: 0.5,
    gravity: 1.6,
    drag: 0.85,
    scale: 0.13,
    opacity: 0.88,
    scaleFade: 0.98,
    geometry: "icosahedron",
    yOffset: [0.4, 1.4],
  },
  guard: {
    count: 10,
    color: 0x66bbff,
    speed: [0.7, 1.2],
    life: 0.7,
    gravity: -1.0,
    drag: 0.91,
    scale: 0.13,
    opacity: 0.7,
    scaleFade: 0.98,
    geometry: "sphere",
    yOffset: [0.2, 1.6],
  },
  battleStart: {
    count: 24,
    color: 0xffbb33,
    speed: [2.2, 3.5],
    life: 1.0,
    gravity: 2.4,
    drag: 0.87,
    scale: 0.17,
    opacity: 0.88,
    scaleFade: 0.983,
    geometry: "icosahedron",
    yOffset: [0.4, 1.8],
  },
  flee: {
    count: 8,
    color: 0xc9d1d9,
    speed: [1.2, 2.0],
    life: 0.6,
    gravity: -0.5,
    drag: 0.9,
    scale: 0.1,
    opacity: 0.55,
    scaleFade: 0.98,
    geometry: "sphere",
    yOffset: [0.2, 1.0],
  },
  truce: {
    count: 18,
    color: 0x44dd66,
    speed: [0.9, 1.6],
    life: 1.1,
    gravity: -1.4,
    drag: 0.93,
    scale: 0.14,
    opacity: 0.75,
    scaleFade: 0.984,
    geometry: "sphere",
    yOffset: [0.2, 1.6],
  },
};

const RING_PRESETS: Record<string, RingPreset> = {
  hit: {
    color: 0xff7755,
    life: 0.5,
    growSpeed: 4.0,
    startScale: 0.5,
    opacity: 0.55,
  },
  death: {
    color: 0xff3333,
    life: 1.1,
    growSpeed: 6.0,
    startScale: 0.5,
    opacity: 0.55,
  },
  battleStart: {
    color: 0xffbb33,
    life: 0.9,
    growSpeed: 5.0,
    startScale: 0.35,
    opacity: 0.6,
  },
  guard: {
    color: 0x66bbff,
    life: 0.6,
    growSpeed: 2.8,
    startScale: 0.3,
    opacity: 0.4,
  },
  slash: {
    color: 0xffcc44,
    life: 0.4,
    growSpeed: 5.5,
    startScale: 0.3,
    opacity: 0.55,
  },
  flee: {
    color: 0xc9d1d9,
    life: 0.6,
    growSpeed: 4.2,
    startScale: 0.3,
    opacity: 0.35,
  },
  truce: {
    color: 0x44dd66,
    life: 1.0,
    growSpeed: 3.5,
    startScale: 0.3,
    opacity: 0.5,
  },
};

// ── Internal pool types ─────────────────────────────────────────

interface PooledParticle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  drag: number;
  gravity: number;
  scaleFade: number;
  active: boolean;
}

interface PooledRing {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  growSpeed: number;
  active: boolean;
}

// ── Particle engine ─────────────────────────────────────────────

const MAX_PARTICLES = 384;
const MAX_RINGS = 24;

export class ParticleEngine {
  private scene: THREE.Scene;

  private icoGeometry = new THREE.IcosahedronGeometry(0.11, 0);
  private sphereGeometry = new THREE.SphereGeometry(0.08, 8, 6);
  private ringGeometry = new THREE.RingGeometry(0.5, 0.68, 28);

  private materialCache = new Map<string, THREE.MeshBasicMaterial>();

  private particlePool: PooledParticle[] = [];
  private activeParticles: PooledParticle[] = [];
  private ringPool: PooledRing[] = [];
  private activeRings: PooledRing[] = [];

  private customPresets = new Map<string, ParticlePreset>();
  private customRingPresets = new Map<string, RingPreset>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.warmPool();
  }

  /** Register a custom particle preset at runtime */
  registerPreset(name: string, preset: ParticlePreset): void {
    this.customPresets.set(name, preset);
  }

  /** Register a custom ring preset at runtime */
  registerRingPreset(name: string, preset: RingPreset): void {
    this.customRingPresets.set(name, preset);
  }

  /** Emit particles from a preset at a world position */
  emit(presetName: string, position: THREE.Vector3, options?: EmitOptions): void {
    const preset = this.customPresets.get(presetName) ?? PRESETS[presetName];
    if (!preset) return;

    const count = options?.count ?? preset.count;
    const color = options?.color ?? preset.color;
    const life = options?.life ?? preset.life;
    const speed = options?.speed ?? preset.speed;
    const scale = options?.scale ?? preset.scale;

    for (let i = 0; i < count; i++) {
      const p = this.acquireParticle(preset.geometry);
      if (!p) return;

      // Material
      const mat = this.getMaterial(color, preset.opacity);
      p.mesh.material = mat;

      // Scale
      const s = scale * (0.8 + Math.random() * 0.65);
      p.mesh.scale.setScalar(s);

      // Position
      const yOff = preset.yOffset[0] + Math.random() * (preset.yOffset[1] - preset.yOffset[0]);
      p.mesh.position.copy(position);
      p.mesh.position.y += yOff;

      // Directional offset (trail puff: spawn behind movement direction)
      if (preset.directional && options?.rotation != null) {
        const rot = options.rotation;
        const backward = new THREE.Vector3(
          Math.sin(rot + Math.PI),
          0,
          Math.cos(rot + Math.PI),
        );
        const side = new THREE.Vector3(-backward.z, 0, backward.x).multiplyScalar(
          (Math.random() - 0.5) * 0.55,
        );
        p.mesh.position.add(backward.multiplyScalar(0.9)).add(side);
      }

      // Spark ring offset
      if (presetName === "spark") {
        const angle = Math.random() * Math.PI * 2;
        const radius = 0.9 + Math.random() * 0.75;
        p.mesh.position.x = position.x + Math.cos(angle) * radius;
        p.mesh.position.z = position.z + Math.sin(angle) * radius;
      }

      // Velocity
      const spd = speed[0] + Math.random() * (speed[1] - speed[0]);
      p.velocity.set(
        (Math.random() - 0.5) * spd,
        (preset.directional ? 0.42 + Math.random() * 0.2 : 0.8 + Math.random() * spd * 0.45),
        (Math.random() - 0.5) * spd,
      );

      p.life = life;
      p.maxLife = life;
      p.drag = preset.drag;
      p.gravity = preset.gravity;
      p.scaleFade = preset.scaleFade;
      p.active = true;
      p.mesh.visible = true;
    }
  }

  /** Emit a ring pulse effect */
  emitRing(presetName: string, position: THREE.Vector3): void {
    const preset = this.customRingPresets.get(presetName) ?? RING_PRESETS[presetName];
    if (!preset) return;

    const ring = this.acquireRing();
    if (!ring) return;

    const mat = this.getMaterial(preset.color, preset.opacity);
    mat.side = THREE.DoubleSide;
    ring.mesh.material = mat;
    ring.mesh.rotation.x = -Math.PI / 2;
    ring.mesh.position.set(position.x, 0.08, position.z);
    ring.mesh.scale.setScalar(preset.startScale);

    ring.life = preset.life;
    ring.maxLife = preset.life;
    ring.growSpeed = preset.growSpeed;
    ring.active = true;
    ring.mesh.visible = true;
  }

  /** Per-frame update — physics, opacity fade, recycling */
  update(delta: number): void {
    // Update particles
    for (let i = this.activeParticles.length - 1; i >= 0; i--) {
      const p = this.activeParticles[i];
      p.life -= delta;

      if (p.life <= 0) {
        this.releaseParticle(p, i);
        continue;
      }

      p.velocity.y -= p.gravity * delta;
      const drag = Math.pow(p.drag, delta * 60);
      p.velocity.multiplyScalar(drag);
      p.mesh.position.addScaledVector(p.velocity, delta);
      p.mesh.scale.multiplyScalar(p.scaleFade);

      const mat = p.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 0.9 * (p.life / p.maxLife));
    }

    // Update rings
    for (let i = this.activeRings.length - 1; i >= 0; i--) {
      const ring = this.activeRings[i];
      ring.life -= delta;

      if (ring.life <= 0) {
        this.releaseRing(ring, i);
        continue;
      }

      ring.mesh.scale.addScalar(delta * ring.growSpeed);
      const mat = ring.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.5 * (ring.life / ring.maxLife);
    }
  }

  /** Dispose all GPU resources */
  dispose(): void {
    for (const p of [...this.particlePool, ...this.activeParticles]) {
      this.scene.remove(p.mesh);
      (p.mesh.material as THREE.Material).dispose();
    }
    for (const r of [...this.ringPool, ...this.activeRings]) {
      this.scene.remove(r.mesh);
      (r.mesh.material as THREE.Material).dispose();
    }
    this.icoGeometry.dispose();
    this.sphereGeometry.dispose();
    this.ringGeometry.dispose();
    for (const mat of this.materialCache.values()) mat.dispose();
    this.particlePool = [];
    this.activeParticles = [];
    this.ringPool = [];
    this.activeRings = [];
    this.materialCache.clear();
  }

  // ── Pool internals ────────────────────────────────────────────

  private warmPool(): void {
    const defaultMat = this.getMaterial(0xffffff, 0);

    for (let i = 0; i < MAX_PARTICLES; i++) {
      // Alternate geometry to have both types pre-allocated
      const geo = i % 4 === 0 ? this.sphereGeometry : this.icoGeometry;
      const mesh = new THREE.Mesh(geo, defaultMat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.particlePool.push({
        mesh,
        velocity: new THREE.Vector3(),
        life: 0,
        maxLife: 0,
        drag: 0,
        gravity: 0,
        scaleFade: 1,
        active: false,
      });
    }

    for (let i = 0; i < MAX_RINGS; i++) {
      const mesh = new THREE.Mesh(this.ringGeometry, defaultMat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.ringPool.push({
        mesh,
        life: 0,
        maxLife: 0,
        growSpeed: 0,
        active: false,
      });
    }
  }

  private acquireParticle(geoType: "icosahedron" | "sphere"): PooledParticle | null {
    const geo = geoType === "sphere" ? this.sphereGeometry : this.icoGeometry;

    // Try to find a matching pooled particle
    for (let i = 0; i < this.particlePool.length; i++) {
      const p = this.particlePool[i];
      if (p.mesh.geometry === geo) {
        this.particlePool.splice(i, 1);
        this.activeParticles.push(p);
        return p;
      }
    }

    // Fall back to any available particle and swap geometry
    if (this.particlePool.length > 0) {
      const p = this.particlePool.pop()!;
      p.mesh.geometry = geo;
      this.activeParticles.push(p);
      return p;
    }

    // Pool exhausted — recycle the oldest active particle
    if (this.activeParticles.length > 0) {
      const p = this.activeParticles.shift()!;
      p.mesh.geometry = geo;
      p.mesh.visible = false;
      this.activeParticles.push(p);
      return p;
    }

    return null;
  }

  private acquireRing(): PooledRing | null {
    if (this.ringPool.length > 0) {
      const r = this.ringPool.pop()!;
      this.activeRings.push(r);
      return r;
    }
    if (this.activeRings.length > 0) {
      const r = this.activeRings.shift()!;
      r.mesh.visible = false;
      this.activeRings.push(r);
      return r;
    }
    return null;
  }

  private releaseParticle(p: PooledParticle, index: number): void {
    p.active = false;
    p.mesh.visible = false;
    this.activeParticles.splice(index, 1);
    this.particlePool.push(p);
  }

  private releaseRing(r: PooledRing, index: number): void {
    r.active = false;
    r.mesh.visible = false;
    this.activeRings.splice(index, 1);
    this.ringPool.push(r);
  }

  private getMaterial(color: THREE.ColorRepresentation, opacity: number): THREE.MeshBasicMaterial {
    const c = new THREE.Color(color);
    const key = `${c.getHexString()}_${opacity.toFixed(2)}`;
    let mat = this.materialCache.get(key);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color: c,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      this.materialCache.set(key, mat);
    }
    return mat;
  }
}
