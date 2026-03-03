import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

// ── Paths ────────────────────────────────────────────────────────────
const MODEL_PATH = "/Models/lobsterDownloaded.gltf";
const TEXTURE_PATH = "/Models/LobsterTexture.png";

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
let cachedBaseTexture: HTMLImageElement | null = null;
const hueTextureCache = new Map<number, THREE.CanvasTexture>();

// ── Model loader ─────────────────────────────────────────────────────

/**
 * Load the GLTF lobster model and its base texture once.
 * Subsequent calls return immediately from cache.
 */
export async function loadLobsterModel(): Promise<void> {
  if (cachedScene) return;

  const loader = new GLTFLoader();
  const textureLoader = new THREE.TextureLoader();

  const [gltf, baseTexture] = await Promise.all([
    loader.loadAsync(MODEL_PATH),
    new Promise<HTMLImageElement>((resolve, reject) => {
      const tex = textureLoader.load(
        TEXTURE_PATH,
        (t) => resolve(t.image as HTMLImageElement),
        undefined,
        reject,
      );
      // We need the image element for canvas hue-shift; the texture object
      // itself is disposed — each instance gets its own CanvasTexture.
      tex.dispose();
    }),
  ]);

  cachedScene = gltf.scene;
  cachedClips = gltf.animations;
  cachedBaseTexture = baseTexture;

  console.log(
    `[lobster] Model loaded — ${cachedClips.length} clips, ` +
      `${cachedScene.children.length} root children`,
  );
}

// ── Hue-shift texture ────────────────────────────────────────────────

/**
 * Convert a CSS colour string to a hue angle (0-360).
 * Falls back to 0 (red) on parse failure.
 */
function colorToHue(color: string): number {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return Math.round(hsl.h * 360);
}

/**
 * Create a canvas copy of the base texture with a CSS hue-rotate filter
 * applied. The result is cached by hue angle so duplicate colours reuse
 * the same GPU texture.
 */
function getHueShiftedTexture(hueAngle: number): THREE.CanvasTexture {
  const cached = hueTextureCache.get(hueAngle);
  if (cached) return cached;

  if (!cachedBaseTexture) {
    throw new Error("[lobster] Base texture not loaded — call loadLobsterModel() first");
  }

  const img = cachedBaseTexture;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;

  const ctx = canvas.getContext("2d")!;
  ctx.filter = `hue-rotate(${hueAngle}deg)`;
  ctx.drawImage(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false; // GLTF convention
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  hueTextureCache.set(hueAngle, tex);
  return tex;
}

// ── Instance creator ─────────────────────────────────────────────────

/**
 * Clone the cached GLTF model, apply a per-agent hue-shifted texture,
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

  // Hue-shifted texture for this agent
  const hue = colorToHue(color);
  const tex = getHueShiftedTexture(hue);

  // Collect all materials (we clone them so emissive hit-flash is independent)
  const materials: THREE.Material[] = [];

  cloned.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;

    // Clone material per instance
    if (Array.isArray(child.material)) {
      child.material = child.material.map((m: THREE.Material) => {
        const clonedMat = m.clone();
        if (clonedMat instanceof THREE.MeshStandardMaterial) {
          clonedMat.map = tex;
          clonedMat.emissiveMap = tex;
          clonedMat.needsUpdate = true;
        }
        materials.push(clonedMat);
        return clonedMat;
      });
    } else {
      const clonedMat = child.material.clone();
      if (clonedMat instanceof THREE.MeshStandardMaterial) {
        clonedMat.map = tex;
        clonedMat.emissiveMap = tex;
        clonedMat.needsUpdate = true;
      }
      materials.push(clonedMat);
      child.material = clonedMat;
    }
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
