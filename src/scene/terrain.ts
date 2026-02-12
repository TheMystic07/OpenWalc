import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ── Constants ─────────────────────────────────────────────────────

const ISLAND_RADIUS = 145;
const GLTF_BASE =
  "/Models/KayKit_Forest_Nature_Pack_1.0_FREE/" +
  "KayKit_Forest_Nature_Pack_1.0_FREE/Assets/gltf/";

// ── Biome System ──────────────────────────────────────────────────

type BiomeType = "meadow" | "forest" | "rocky" | "deepwoods" | "wetlands";

const BIOME_COLORS: Record<BiomeType, THREE.Color> = {
  meadow:    new THREE.Color(0x7ec850),
  forest:    new THREE.Color(0x3a6b30),
  rocky:     new THREE.Color(0x8a7d6b),
  deepwoods: new THREE.Color(0x2d5a28),
  wetlands:  new THREE.Color(0x5b7b4a),
};

const BEACH_COLOR = new THREE.Color(0xc2b280);
const SHALLOWS_COLOR = new THREE.Color(0x5aadba);

/** Deterministic pseudo-noise for organic terrain variation. */
function noise2d(x: number, z: number): number {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/** Seeded PRNG so every client generates identical terrain. */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Determine the biome for a given world-space position. */
function getBiome(x: number, z: number): BiomeType {
  const dist = Math.sqrt(x * x + z * z);
  if (dist < 38) return "meadow";

  const angle = Math.atan2(z, x);
  if (angle >= -Math.PI && angle < -Math.PI / 2) return "forest";
  if (angle >= -Math.PI / 2 && angle < 0) return "rocky";
  if (angle >= 0 && angle < Math.PI / 2) return "wetlands";
  return "deepwoods";
}

/** Compute a smoothly-blended ground colour for a vertex. */
function getGroundColor(x: number, z: number): THREE.Color {
  const dist = Math.sqrt(x * x + z * z);
  const n = noise2d(x * 0.04, z * 0.04) * 0.08 - 0.04;

  if (dist > 142) return SHALLOWS_COLOR.clone();
  if (dist > 125) {
    const t = (dist - 125) / 17;
    const base = getBiomeBaseColor(x, z);
    base.lerp(BEACH_COLOR, t);
    return base;
  }
  if (dist < 30) {
    const c = BIOME_COLORS.meadow.clone();
    c.r += n; c.g += n; c.b += n;
    return c;
  }
  if (dist < 50) {
    const t = (dist - 30) / 20;
    const meadow = BIOME_COLORS.meadow.clone();
    const biome = getBiomeBaseColor(x, z);
    meadow.lerp(biome, t);
    meadow.r += n; meadow.g += n; meadow.b += n;
    return meadow;
  }

  const c = getBiomeBaseColor(x, z);
  c.r += n; c.g += n; c.b += n;
  return c;
}

/**
 * Return the biome colour with angular blending at sector boundaries
 * so that the four outer biomes merge smoothly.
 */
function getBiomeBaseColor(x: number, z: number): THREE.Color {
  const angle = Math.atan2(z, x);
  const blendWidth = 0.35;

  const boundaries = [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI];
  const colors: THREE.Color[] = [
    BIOME_COLORS.forest,
    BIOME_COLORS.rocky,
    BIOME_COLORS.wetlands,
    BIOME_COLORS.deepwoods,
  ];

  let idx = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (angle >= boundaries[i] && angle < boundaries[i + 1]) { idx = i; break; }
  }

  const lo = boundaries[idx];
  const hi = boundaries[idx + 1];
  const mid = (lo + hi) / 2;
  const halfSpan = (hi - lo) / 2;
  const fromEdge = halfSpan - Math.abs(angle - mid);

  if (fromEdge < blendWidth) {
    const t = 0.5 - (fromEdge / blendWidth) * 0.5;
    const neighbourIdx = angle < mid
      ? (idx - 1 + colors.length) % colors.length
      : (idx + 1) % colors.length;
    return colors[idx].clone().lerp(colors[neighbourIdx], t);
  }

  return colors[idx].clone();
}

// ── Circular Terrain Floor ────────────────────────────────────────

function createFloor(scene: THREE.Scene): void {
  // Circular island mesh matching the circular biome layout
  const radialSegments = 128;
  const ringSegments = 80;
  const geo = new THREE.CircleGeometry(ISLAND_RADIUS, radialSegments, 0, Math.PI * 2);

  // CircleGeometry is flat on XY; we need it on XZ
  geo.rotateX(-Math.PI / 2);

  // Subdivide for better vertex colour resolution: use a custom ring-based approach
  // CircleGeometry gives us a center vertex + concentric rings which is perfect
  // for our radial biome system.

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const col = getGroundColor(x, z);
    colors[i * 3]     = THREE.MathUtils.clamp(col.r, 0, 1);
    colors[i * 3 + 1] = THREE.MathUtils.clamp(col.g, 0, 1);
    colors[i * 3 + 2] = THREE.MathUtils.clamp(col.b, 0, 1);
  }

  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  // For better vertex density, use a RingGeometry from 0 to ISLAND_RADIUS
  // (CircleGeometry with few segments won't have enough colour detail)
  const detailedGeo = new THREE.RingGeometry(0, ISLAND_RADIUS, radialSegments, ringSegments);
  detailedGeo.rotateX(-Math.PI / 2);

  const detailedPos = detailedGeo.attributes.position;
  const detailedColors = new Float32Array(detailedPos.count * 3);

  for (let i = 0; i < detailedPos.count; i++) {
    const x = detailedPos.getX(i);
    const z = detailedPos.getZ(i);
    const col = getGroundColor(x, z);
    detailedColors[i * 3]     = THREE.MathUtils.clamp(col.r, 0, 1);
    detailedColors[i * 3 + 1] = THREE.MathUtils.clamp(col.g, 0, 1);
    detailedColors[i * 3 + 2] = THREE.MathUtils.clamp(col.b, 0, 1);
  }

  detailedGeo.setAttribute("color", new THREE.BufferAttribute(detailedColors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.05,
  });

  const floor = new THREE.Mesh(detailedGeo, mat);
  floor.receiveShadow = true;
  scene.add(floor);

  // Dispose the simple circle since we use the detailed ring instead
  geo.dispose();
}

// ── Animated Water (simple vertex wave plane) ─────────────────────

interface WaterVertData {
  initY: number;
  amplitude: number;
  phase: number;
}

function createWater(scene: THREE.Scene): { animate: (time: number) => void } {
  // Ring geometry: water only exists outside the island so it can't clip land
  const innerR = ISLAND_RADIUS - 2; // slight overlap for seamless edge
  const outerR = 500;
  const thetaSegs = 96;
  const phiSegs = 30;
  const g = new THREE.RingGeometry(innerR, outerR, thetaSegs, phiSegs);
  g.rotateX(-Math.PI * 0.5);

  // Store per-vertex wave data
  const rng = seededRandom(73);
  const vertData: WaterVertData[] = [];
  const v3 = new THREE.Vector3();

  for (let i = 0; i < g.attributes.position.count; i++) {
    v3.fromBufferAttribute(g.attributes.position, i);
    // Waves grow stronger further from shore
    const dist = Math.sqrt(v3.x * v3.x + v3.z * v3.z);
    const coastFade = THREE.MathUtils.smoothstep(dist, innerR, innerR + 40);
    vertData.push({
      initY: v3.y,
      amplitude: THREE.MathUtils.randFloatSpread(1.5) * coastFade,
      phase: rng() * Math.PI * 2,
    });
  }

  const m = new THREE.MeshLambertMaterial({
    color: 0x2f9ab8,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
  });

  const water = new THREE.Mesh(g, m);
  water.position.y = -0.6;
  water.receiveShadow = true;
  scene.add(water);

  const animate = (time: number) => {
    const posAttr = g.attributes.position;
    for (let i = 0; i < vertData.length; i++) {
      const vd = vertData[i];
      const y = vd.initY + Math.sin(time + vd.phase) * vd.amplitude;
      posAttr.setY(i, y);
    }
    posAttr.needsUpdate = true;
    g.computeVertexNormals();
  };

  return { animate };
}

// ── Floating Particles (fireflies + dust motes) ──────────────────

function createParticles(scene: THREE.Scene): (time: number) => void {
  // Dust motes
  const dustCount = 800;
  const dustGeo = new THREE.BufferGeometry();
  const dustPositions = new Float32Array(dustCount * 3);

  for (let i = 0; i < dustCount; i++) {
    dustPositions[i * 3]     = (Math.random() - 0.5) * 280;
    dustPositions[i * 3 + 1] = Math.random() * 25;
    dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 280;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));

  const dustMat = new THREE.PointsMaterial({
    color: 0xffeedd,
    size: 0.18,
    transparent: true,
    opacity: 0.35,
    sizeAttenuation: true,
  });
  scene.add(new THREE.Points(dustGeo, dustMat));

  // Fireflies (warm golden particles near the ground)
  const fireflyCount = 120;
  const fireflyGeo = new THREE.BufferGeometry();
  const fireflyPositions = new Float32Array(fireflyCount * 3);

  for (let i = 0; i < fireflyCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 20 + Math.random() * 100;
    fireflyPositions[i * 3]     = Math.cos(angle) * radius;
    fireflyPositions[i * 3 + 1] = 0.5 + Math.random() * 6;
    fireflyPositions[i * 3 + 2] = Math.sin(angle) * radius;
  }
  fireflyGeo.setAttribute("position", new THREE.BufferAttribute(fireflyPositions, 3));

  const fireflyMat = new THREE.PointsMaterial({
    color: 0xffdd44,
    size: 0.35,
    transparent: true,
    opacity: 0.7,
    sizeAttenuation: true,
  });
  scene.add(new THREE.Points(fireflyGeo, fireflyMat));

  const dustOriginal = dustPositions.slice();
  const fireflyOriginal = fireflyPositions.slice();

  return (time: number) => {
    const dustAttr = dustGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < dustCount; i++) {
      dustAttr.array[i * 3 + 1] =
        dustOriginal[i * 3 + 1] + Math.sin(time * 0.5 + i) * 0.4;
    }
    dustAttr.needsUpdate = true;

    const ffAttr = fireflyGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < fireflyCount; i++) {
      const phase = i * 1.618;
      ffAttr.array[i * 3]     = fireflyOriginal[i * 3] + Math.sin(time * 0.3 + phase) * 2;
      ffAttr.array[i * 3 + 1] = fireflyOriginal[i * 3 + 1] + Math.sin(time * 0.7 + phase * 0.5) * 1.5;
      ffAttr.array[i * 3 + 2] = fireflyOriginal[i * 3 + 2] + Math.cos(time * 0.4 + phase * 0.8) * 2;
    }
    ffAttr.needsUpdate = true;
    fireflyMat.opacity = 0.4 + Math.sin(time * 1.5) * 0.3;
  };
}

// ── Model Definitions per Biome (Mac-friendly counts) ─────────────

interface ModelDef {
  file: string;
  biomes: BiomeType[];
  count: number;
  scaleRange: [number, number];
  isObstacle: boolean;
  obstacleRadius: number;
}

const MODEL_DEFS: ModelDef[] = [
  // ── Trees (reduced counts for Mac GPU performance) ──
  { file: "Tree_1_A_Color1.gltf",      biomes: ["forest", "meadow"],                count: 8,  scaleRange: [1.8, 3.0], isObstacle: true,  obstacleRadius: 1.8 },
  { file: "Tree_1_B_Color1.gltf",      biomes: ["forest", "wetlands"],              count: 7,  scaleRange: [1.6, 2.6], isObstacle: true,  obstacleRadius: 1.8 },
  { file: "Tree_1_C_Color1.gltf",      biomes: ["forest", "meadow"],                count: 6,  scaleRange: [1.5, 2.4], isObstacle: true,  obstacleRadius: 1.6 },
  { file: "Tree_2_A_Color1.gltf",      biomes: ["deepwoods", "forest"],             count: 8,  scaleRange: [2.0, 3.2], isObstacle: true,  obstacleRadius: 2.2 },
  { file: "Tree_2_B_Color1.gltf",      biomes: ["deepwoods", "forest"],             count: 7,  scaleRange: [1.8, 2.8], isObstacle: true,  obstacleRadius: 2.0 },
  { file: "Tree_2_C_Color1.gltf",      biomes: ["deepwoods"],                       count: 5,  scaleRange: [2.0, 3.0], isObstacle: true,  obstacleRadius: 2.0 },
  { file: "Tree_2_D_Color1.gltf",      biomes: ["deepwoods", "wetlands"],           count: 4,  scaleRange: [1.8, 2.6], isObstacle: true,  obstacleRadius: 1.8 },
  { file: "Tree_2_E_Color1.gltf",      biomes: ["forest", "deepwoods"],             count: 4,  scaleRange: [2.2, 3.0], isObstacle: true,  obstacleRadius: 2.0 },
  { file: "Tree_3_A_Color1.gltf",      biomes: ["deepwoods"],                       count: 6,  scaleRange: [2.2, 3.4], isObstacle: true,  obstacleRadius: 2.4 },
  { file: "Tree_3_B_Color1.gltf",      biomes: ["deepwoods", "forest"],             count: 5,  scaleRange: [2.0, 3.0], isObstacle: true,  obstacleRadius: 2.2 },
  { file: "Tree_3_C_Color1.gltf",      biomes: ["deepwoods"],                       count: 4,  scaleRange: [2.4, 3.6], isObstacle: true,  obstacleRadius: 2.6 },
  { file: "Tree_4_A_Color1.gltf",      biomes: ["meadow", "wetlands"],              count: 5,  scaleRange: [1.5, 2.2], isObstacle: true,  obstacleRadius: 1.4 },
  { file: "Tree_4_B_Color1.gltf",      biomes: ["meadow", "wetlands"],              count: 4,  scaleRange: [1.4, 2.0], isObstacle: true,  obstacleRadius: 1.4 },
  { file: "Tree_4_C_Color1.gltf",      biomes: ["meadow"],                          count: 3,  scaleRange: [1.3, 1.8], isObstacle: true,  obstacleRadius: 1.2 },
  { file: "Tree_Bare_1_A_Color1.gltf", biomes: ["rocky", "wetlands"],               count: 6,  scaleRange: [1.8, 2.8], isObstacle: true,  obstacleRadius: 1.4 },
  { file: "Tree_Bare_1_B_Color1.gltf", biomes: ["rocky"],                           count: 4,  scaleRange: [1.6, 2.4], isObstacle: true,  obstacleRadius: 1.4 },
  { file: "Tree_Bare_1_C_Color1.gltf", biomes: ["rocky", "wetlands"],               count: 3,  scaleRange: [1.5, 2.2], isObstacle: true,  obstacleRadius: 1.2 },
  { file: "Tree_Bare_2_A_Color1.gltf", biomes: ["rocky"],                           count: 5,  scaleRange: [1.5, 2.4], isObstacle: true,  obstacleRadius: 1.4 },
  { file: "Tree_Bare_2_B_Color1.gltf", biomes: ["rocky", "wetlands"],               count: 4,  scaleRange: [1.4, 2.2], isObstacle: true,  obstacleRadius: 1.2 },
  { file: "Tree_Bare_2_C_Color1.gltf", biomes: ["rocky"],                           count: 3,  scaleRange: [1.6, 2.4], isObstacle: true,  obstacleRadius: 1.4 },

  // ── Rocks (diverse formations) ──
  { file: "Rock_1_A_Color1.gltf",      biomes: ["rocky", "wetlands", "forest"],     count: 10, scaleRange: [1.2, 2.4], isObstacle: true,  obstacleRadius: 1.4 },
  { file: "Rock_1_B_Color1.gltf",      biomes: ["rocky", "forest"],                 count: 6,  scaleRange: [1.0, 2.0], isObstacle: true,  obstacleRadius: 1.2 },
  { file: "Rock_1_C_Color1.gltf",      biomes: ["rocky", "deepwoods"],              count: 5,  scaleRange: [1.2, 2.2], isObstacle: true,  obstacleRadius: 1.4 },
  { file: "Rock_1_D_Color1.gltf",      biomes: ["rocky"],                           count: 8,  scaleRange: [1.4, 2.8], isObstacle: true,  obstacleRadius: 1.8 },
  { file: "Rock_1_E_Color1.gltf",      biomes: ["rocky", "meadow"],                 count: 5,  scaleRange: [0.8, 1.6], isObstacle: true,  obstacleRadius: 1.0 },
  { file: "Rock_1_F_Color1.gltf",      biomes: ["rocky", "wetlands"],               count: 4,  scaleRange: [1.0, 1.8], isObstacle: true,  obstacleRadius: 1.2 },
  { file: "Rock_2_A_Color1.gltf",      biomes: ["rocky", "meadow"],                 count: 8,  scaleRange: [0.8, 1.6], isObstacle: true,  obstacleRadius: 1.0 },
  { file: "Rock_2_B_Color1.gltf",      biomes: ["rocky", "forest"],                 count: 5,  scaleRange: [0.6, 1.4], isObstacle: false, obstacleRadius: 0 },
  { file: "Rock_2_C_Color1.gltf",      biomes: ["meadow", "wetlands"],              count: 5,  scaleRange: [0.5, 1.2], isObstacle: false, obstacleRadius: 0 },
  { file: "Rock_2_D_Color1.gltf",      biomes: ["rocky"],                           count: 4,  scaleRange: [0.8, 1.6], isObstacle: false, obstacleRadius: 0 },
  { file: "Rock_3_A_Color1.gltf",      biomes: ["rocky"],                           count: 6,  scaleRange: [1.8, 3.2], isObstacle: true,  obstacleRadius: 2.4 },
  { file: "Rock_3_B_Color1.gltf",      biomes: ["rocky", "deepwoods"],              count: 4,  scaleRange: [1.6, 2.8], isObstacle: true,  obstacleRadius: 2.0 },
  { file: "Rock_3_C_Color1.gltf",      biomes: ["rocky"],                           count: 3,  scaleRange: [2.0, 3.4], isObstacle: true,  obstacleRadius: 2.6 },

  // ── Bushes (lush undergrowth, lightweight) ──
  { file: "Bush_1_A_Color1.gltf",      biomes: ["forest", "deepwoods", "meadow"],   count: 14, scaleRange: [1.5, 2.6], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_1_B_Color1.gltf",      biomes: ["forest", "meadow"],                count: 10, scaleRange: [1.3, 2.2], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_1_C_Color1.gltf",      biomes: ["deepwoods", "wetlands"],           count: 8,  scaleRange: [1.4, 2.4], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_1_D_Color1.gltf",      biomes: ["forest", "deepwoods"],             count: 7,  scaleRange: [1.2, 2.0], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_1_E_Color1.gltf",      biomes: ["meadow", "wetlands"],              count: 6,  scaleRange: [1.0, 1.8], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_1_F_Color1.gltf",      biomes: ["forest"],                          count: 6,  scaleRange: [1.2, 2.0], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_1_G_Color1.gltf",      biomes: ["deepwoods"],                       count: 5,  scaleRange: [1.4, 2.2], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_2_A_Color1.gltf",      biomes: ["forest", "wetlands"],              count: 10, scaleRange: [1.3, 2.2], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_2_B_Color1.gltf",      biomes: ["wetlands", "meadow"],              count: 8,  scaleRange: [1.2, 2.0], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_2_C_Color1.gltf",      biomes: ["forest", "deepwoods"],             count: 7,  scaleRange: [1.0, 1.8], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_2_D_Color1.gltf",      biomes: ["wetlands"],                        count: 5,  scaleRange: [1.2, 2.0], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_2_E_Color1.gltf",      biomes: ["meadow", "forest"],                count: 5,  scaleRange: [1.0, 1.6], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_2_F_Color1.gltf",      biomes: ["deepwoods", "wetlands"],           count: 4,  scaleRange: [1.2, 2.0], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_3_A_Color1.gltf",      biomes: ["meadow", "forest", "wetlands"],    count: 10, scaleRange: [1.4, 2.4], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_3_B_Color1.gltf",      biomes: ["forest", "deepwoods"],             count: 7,  scaleRange: [1.2, 2.0], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_3_C_Color1.gltf",      biomes: ["meadow"],                          count: 6,  scaleRange: [1.0, 1.8], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_4_A_Color1.gltf",      biomes: ["meadow", "deepwoods"],             count: 10, scaleRange: [1.0, 2.0], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_4_B_Color1.gltf",      biomes: ["forest", "meadow"],                count: 7,  scaleRange: [0.8, 1.6], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_4_C_Color1.gltf",      biomes: ["deepwoods", "wetlands"],           count: 6,  scaleRange: [1.0, 1.8], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_4_D_Color1.gltf",      biomes: ["meadow"],                          count: 5,  scaleRange: [0.8, 1.4], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_4_E_Color1.gltf",      biomes: ["forest", "wetlands"],              count: 5,  scaleRange: [0.8, 1.4], isObstacle: false, obstacleRadius: 0 },
  { file: "Bush_4_F_Color1.gltf",      biomes: ["deepwoods"],                       count: 4,  scaleRange: [1.0, 1.6], isObstacle: false, obstacleRadius: 0 },

  // ── Grass patches (dense ground cover, very lightweight) ──
  { file: "Grass_1_A_Color1.gltf",     biomes: ["meadow", "forest", "wetlands"],    count: 25, scaleRange: [1.5, 3.0], isObstacle: false, obstacleRadius: 0 },
  { file: "Grass_1_B_Color1.gltf",     biomes: ["meadow", "forest"],                count: 20, scaleRange: [1.4, 2.6], isObstacle: false, obstacleRadius: 0 },
  { file: "Grass_1_C_Color1.gltf",     biomes: ["wetlands", "deepwoods"],           count: 16, scaleRange: [1.5, 2.8], isObstacle: false, obstacleRadius: 0 },
  { file: "Grass_1_D_Color1.gltf",     biomes: ["meadow", "wetlands"],              count: 14, scaleRange: [1.2, 2.4], isObstacle: false, obstacleRadius: 0 },
  { file: "Grass_2_A_Color1.gltf",     biomes: ["meadow", "deepwoods", "wetlands"], count: 22, scaleRange: [1.5, 3.0], isObstacle: false, obstacleRadius: 0 },
  { file: "Grass_2_B_Color1.gltf",     biomes: ["forest", "meadow"],                count: 18, scaleRange: [1.4, 2.6], isObstacle: false, obstacleRadius: 0 },
  { file: "Grass_2_C_Color1.gltf",     biomes: ["deepwoods", "wetlands"],           count: 14, scaleRange: [1.5, 2.8], isObstacle: false, obstacleRadius: 0 },
  { file: "Grass_2_D_Color1.gltf",     biomes: ["meadow", "forest"],                count: 12, scaleRange: [1.2, 2.4], isObstacle: false, obstacleRadius: 0 },
];

// ── Obstacle Type ─────────────────────────────────────────────────

export interface TerrainObstacle {
  x: number;
  z: number;
  radius: number;
}

// ── Main Entry Point ──────────────────────────────────────────────

export function createTerrain(scene: THREE.Scene): {
  animateParticles: (time: number) => void;
  ready: Promise<TerrainObstacle[]>;
} {
  createFloor(scene);
  const water = createWater(scene);
  const animateDust = createParticles(scene);

  const animateParticles = (time: number) => {
    water.animate(time);
    animateDust(time);
  };

  const ready = loadAndPlaceModels(scene);

  return { animateParticles, ready };
}

// ── Model Loading & Placement ─────────────────────────────────────

async function loadAndPlaceModels(scene: THREE.Scene): Promise<TerrainObstacle[]> {
  const loader = new GLTFLoader();
  const modelCache = new Map<string, THREE.Group>();

  const uniqueFiles = [...new Set(MODEL_DEFS.map((d) => d.file))];

  const results = await Promise.allSettled(
    uniqueFiles.map(async (file) => {
      const gltf = await loader.loadAsync(GLTF_BASE + file);
      return { file, group: gltf.scene };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      modelCache.set(result.value.file, result.value.group);
    } else {
      console.warn("[terrain] Model load failed:", result.reason);
    }
  }

  console.log(`[terrain] Loaded ${modelCache.size}/${uniqueFiles.length} models`);

  const rng = seededRandom(42);
  const obstacles: TerrainObstacle[] = [];
  const placed: { x: number; z: number }[] = [];

  for (const def of MODEL_DEFS) {
    const template = modelCache.get(def.file);
    if (!template) continue;

    let count = 0;
    let attempts = 0;
    const maxAttempts = def.count * 12;

    while (count < def.count && attempts < maxAttempts) {
      attempts++;

      // Sample within circular island bounds
      const angle = rng() * Math.PI * 2;
      const maxR = 130;
      const minR = 16;
      const r = minR + rng() * (maxR - minR);
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;

      // Must match one of the allowed biomes
      const biome = getBiome(x, z);
      if (!def.biomes.includes(biome)) continue;

      // Minimum spacing between placed objects
      const minSep = def.isObstacle ? 5.5 : 2.8;
      let tooClose = false;
      for (const p of placed) {
        const ddx = x - p.x;
        const ddz = z - p.z;
        if (ddx * ddx + ddz * ddz < minSep * minSep) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const instance = template.clone();
      const scale =
        def.scaleRange[0] + rng() * (def.scaleRange[1] - def.scaleRange[0]);
      instance.scale.setScalar(scale);
      instance.position.set(x, 0, z);
      instance.rotation.y = rng() * Math.PI * 2;

      instance.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      scene.add(instance);
      placed.push({ x, z });

      if (def.isObstacle) {
        obstacles.push({ x, z, radius: def.obstacleRadius * scale });
      }

      count++;
    }
  }

  console.log(
    `[terrain] Placed ${placed.length} objects (${obstacles.length} obstacles)`,
  );
  return obstacles;
}
