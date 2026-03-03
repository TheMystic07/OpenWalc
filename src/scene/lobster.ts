import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

// ── Paths ────────────────────────────────────────────────────────────
const MODEL_PATH = "/Models/lobsterDownloaded.gltf";

// ── Public types ─────────────────────────────────────────────────────

export interface LobsterInstance {
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  materials: THREE.Material[];
}

// ── Action-to-clip mapping ───────────────────────────────────────────

export const ACTION_TO_CLIP: Record<string, string> = {
  // Social / emote actions
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

  // Combat intents
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

export const IDLE_VARIANTS: string[] = ["Idle_A", "Idle_B", "Idle_C"];

/** Pick a random idle clip name. */
export function randomIdleClip(): string {
  return IDLE_VARIANTS[Math.floor(Math.random() * IDLE_VARIANTS.length)];
}

// ── One-shot clips (play once and hold final frame) ──────────────────

const ONE_SHOT_CLIPS = new Set<string>([
  "Attack",
  "Jump",
  "Death",
  "Hit",
  "Clicked",
  "Sit",
  "Lay",
]);

// ── Cached model data (loaded once, shared across instances) ─────────

let cachedScene: THREE.Group | null = null;
let cachedClips: THREE.AnimationClip[] = [];
const colorTextureCache = new Map<string, THREE.CanvasTexture>();

// ── Model loader ─────────────────────────────────────────────────────

/**
 * Load the GLTF lobster model and its base texture once.
 * Subsequent calls return immediately from cache.
 */
export async function loadLobsterModel(): Promise<void> {
  if (cachedScene) return;

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL_PATH);

  cachedScene = gltf.scene;
  cachedClips = gltf.animations;

  console.log(
    `[lobster] Model loaded — ${cachedClips.length} clips, ` +
      `${cachedScene.children.length} root children`,
  );
}

// ── Color-swap texture ────────────────────────────────────────────────

/** Grab the base texture from the GLTF scene (works with any image type). */
let baseTexture: THREE.Texture | null = null;

function ensureBaseTexture(): void {
  if (baseTexture) return;
  cachedScene!.traverse((child) => {
    if (baseTexture) return;
    if (!(child instanceof THREE.Mesh)) return;
    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
    const tex = (mat as THREE.MeshStandardMaterial).map;
    if (tex) baseTexture = tex;
  });
}

/**
 * Check if a pixel is a body color (reds, pinks, yellows/golds) vs
 * the near-white (#f9f8f2) and dark (#292939) which should stay fixed.
 *
 * Palette colors to swap (body):
 *   #fff263, #ffdf69, #f2c34b (yellows)
 *   #ff9090, #f27271, #cc7d95, #e05f5f, #b84444 (reds/pinks)
 * Keep untouched:
 *   #f9f8f2 (near-white — eyes/highlights)
 *   #292939 (dark — outlines/pupils)
 *   #63cdff (blue — accents)
 */
function isBodyPixel(r: number, g: number, b: number): boolean {
  // Near-white: all channels > 240
  if (r > 240 && g > 240 && b > 230) return false;
  // Dark: all channels < 70
  if (r < 70 && g < 70 && b < 70) return false;
  // Blue accent: low R, high G, high B
  if (r < 120 && g > 180 && b > 220) return false;
  // Everything else is body color
  return true;
}

/**
 * Create a recolored copy of the base texture where body-colored pixels
 * are tinted to the agent's color, preserving luminance variation.
 */
function getColorSwappedTexture(color: string): THREE.CanvasTexture {
  const cached = colorTextureCache.get(color);
  if (cached) return cached;

  ensureBaseTexture();

  // Draw the base texture image onto a canvas (works for HTMLImage, ImageBitmap, etc.)
  const source = baseTexture!.image;
  const w = source.width || 8;
  const h = source.height || 8;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0);

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  const target = new THREE.Color(color);
  const tR = target.r * 255;
  const tG = target.g * 255;
  const tB = target.b * 255;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (isBodyPixel(r, g, b)) {
      // Luminance of original pixel as a brightness multiplier
      const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      // Scale by ~1.3 so the target color doesn't get too dark
      const scale = Math.min(lum * 1.3, 1);
      data[i]     = Math.min(255, Math.round(tR * scale));
      data[i + 1] = Math.min(255, Math.round(tG * scale));
      data[i + 2] = Math.min(255, Math.round(tB * scale));
    }
  }

  ctx.putImageData(imageData, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  colorTextureCache.set(color, tex);
  return tex;
}

// ── Instance creator ─────────────────────────────────────────────────

/**
 * Clone the cached GLTF model, swap orange pixels to the agent's color,
 * wire up an AnimationMixer with all clips, and return a LobsterInstance.
 *
 * Requires `loadLobsterModel()` to have completed first.
 */
export function createLobsterInstance(color: string): LobsterInstance {
  if (!cachedScene) {
    throw new Error("[lobster] Model not loaded — call loadLobsterModel() first");
  }

  // Clone with skeleton awareness so bone bindings remain correct
  const cloned = SkeletonUtils.clone(cachedScene) as THREE.Group;
  cloned.name = "lobster";
  cloned.scale.setScalar(0.025);

  // Color-swapped texture for this agent
  const swappedTex = getColorSwappedTexture(color);

  // Collect materials — unlit MeshBasicMaterial with swapped texture
  const materials: THREE.Material[] = [];

  cloned.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;

    const basicMat = new THREE.MeshBasicMaterial({ map: swappedTex });
    materials.push(basicMat);
    child.material = basicMat;
  });

  // AnimationMixer + pre-create all actions
  const mixer = new THREE.AnimationMixer(cloned);
  const actions = new Map<string, THREE.AnimationAction>();

  for (const clip of cachedClips) {
    const action = mixer.clipAction(clip);

    if (ONE_SHOT_CLIPS.has(clip.name)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }

    actions.set(clip.name, action);
  }

  // Start with Idle_A playing
  const idleAction = actions.get("Idle_A");
  if (idleAction) {
    idleAction.play();
  }

  return { group: cloned, mixer, actions, materials };
}

// ── Crossfade helper ─────────────────────────────────────────────────

/**
 * Smoothly crossfade from the currently playing action to `clipName`.
 * If `clipName` is already the active clip, this is a no-op.
 *
 * @param instance  The lobster instance to animate
 * @param clipName  Target GLTF animation clip name (e.g. "Walk", "Attack")
 * @param duration  Crossfade duration in seconds (default 0.2)
 */
export function crossfadeTo(
  instance: LobsterInstance,
  clipName: string,
  duration = 0.2,
): void {
  const target = instance.actions.get(clipName);
  if (!target) return;

  // Find the currently playing action
  let current: THREE.AnimationAction | null = null;
  for (const action of instance.actions.values()) {
    if (action.isRunning() && action !== target) {
      current = action;
      break;
    }
  }

  // Already playing the target clip
  if (target.isRunning()) return;

  // Reset the target in case it was a completed one-shot
  target.reset();
  target.setEffectiveTimeScale(1);
  target.setEffectiveWeight(1);

  if (current) {
    current.crossFadeTo(target, duration, true);
  }

  target.play();
}
