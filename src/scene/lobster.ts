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
/** The original texture from the GLTF, grabbed on first clone. */
let baseTextureImage: HTMLImageElement | null = null;
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

/**
 * Grab the base texture image from the GLTF scene on first call.
 * We need the raw HTMLImageElement to read pixels for color swapping.
 */
function ensureBaseTexture(): void {
  if (baseTextureImage) return;
  cachedScene!.traverse((child) => {
    if (baseTextureImage) return;
    if (!(child instanceof THREE.Mesh)) return;
    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
    const tex = (mat as THREE.MeshStandardMaterial).map;
    if (tex?.image instanceof HTMLImageElement) {
      baseTextureImage = tex.image;
    }
  });
}

/**
 * Check if a pixel is in the orange range (the lobster body color).
 * Orange in RGB: high red, medium green, low blue.
 */
function isOrangePixel(r: number, g: number, b: number): boolean {
  return r > 150 && g > 60 && g < 200 && b < 100 && r > g;
}

/**
 * Create a recolored copy of the base texture where orange pixels
 * are replaced with the agent's color, preserving luminance variation.
 */
function getColorSwappedTexture(color: string): THREE.CanvasTexture {
  const cached = colorTextureCache.get(color);
  if (cached) return cached;

  ensureBaseTexture();
  if (!baseTextureImage) {
    // Fallback: return an empty texture (model will use GLTF default)
    const tex = new THREE.CanvasTexture(document.createElement("canvas"));
    return tex;
  }

  const img = baseTextureImage;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  const target = new THREE.Color(color);
  const tR = Math.round(target.r * 255);
  const tG = Math.round(target.g * 255);
  const tB = Math.round(target.b * 255);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (isOrangePixel(r, g, b)) {
      // Preserve relative brightness: use original luminance as a multiplier
      const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      data[i]     = Math.min(255, Math.round(tR * lum * 1.4));
      data[i + 1] = Math.min(255, Math.round(tG * lum * 1.4));
      data[i + 2] = Math.min(255, Math.round(tB * lum * 1.4));
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
