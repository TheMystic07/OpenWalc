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

// ── Instance creator ─────────────────────────────────────────────────

/**
 * Clone the cached GLTF model, wire up an AnimationMixer with all clips,
 * and return a LobsterInstance. Uses the model's original texture as-is.
 *
 * Requires `loadLobsterModel()` to have completed first.
 */
export function createLobsterInstance(_color: string): LobsterInstance {
  if (!cachedScene) {
    throw new Error("[lobster] Model not loaded — call loadLobsterModel() first");
  }

  // Clone with skeleton awareness so bone bindings remain correct
  const cloned = SkeletonUtils.clone(cachedScene) as THREE.Group;
  cloned.name = "lobster";
  cloned.scale.setScalar(0.025);

  // Collect materials (clone per instance so emissive hit-flash is independent)
  const materials: THREE.Material[] = [];

  cloned.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;

    // Use MeshBasicMaterial (unlit) so the texture shows at full brightness
    // like Blender's Material Preview — no scene lighting affects it.
    const srcMat = Array.isArray(child.material) ? child.material[0] : child.material;
    const tex = (srcMat as THREE.MeshStandardMaterial).map;
    const basicMat = new THREE.MeshBasicMaterial({ map: tex });
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
