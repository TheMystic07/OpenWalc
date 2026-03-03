import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

/* ── Types ──────────────────────────────────────────────────────── */

export type AutoCamMode = "roam" | "battle";

export interface AutoCamDeps {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Return world positions keyed by agentId */
  getAgentPositions: () => Map<string, THREE.Vector3>;
  /** Return active battle midpoints: { battleId, midpoint, participants } */
  getActiveBattles: () => BattleFocus[];
}

export interface BattleFocus {
  battleId: string;
  participants: [string, string];
  midpoint: THREE.Vector3;
}

/* ── Constants ──────────────────────────────────────────────────── */

const ROAM_SWITCH_INTERVAL = 8;       // seconds between agent switches
const ROAM_PAUSE_DURATION = 5;        // seconds to linger on an agent
const ROAM_ORBIT_SPEED = 0.15;        // radians/sec
const ROAM_ORBIT_RADIUS = 20;
const ROAM_ORBIT_HEIGHT = 14;
const ROAM_LERP_SPEED = 0.03;

const BATTLE_ORBIT_RADIUS = 14;
const BATTLE_ORBIT_HEIGHT = 10;
const BATTLE_ORBIT_SPEED = 0.35;
const BATTLE_LERP_SPEED = 0.06;
const BATTLE_CYCLE_INTERVAL = 6;      // seconds between battle switches
const BATTLE_END_LINGER = 3;          // seconds to hold after battle ends

const KO_ZOOM_RADIUS = 8;
const KO_ZOOM_HEIGHT = 6;
const KO_HOLD_DURATION = 2;

/* ── AutoCam Class ──────────────────────────────────────────────── */

export class AutoCam {
  private enabled = false;
  private mode: AutoCamMode = "roam";
  private deps: AutoCamDeps;

  // Roam state
  private roamTimer = 0;
  private roamAngle = 0;
  private roamTargetId: string | null = null;
  private roamTargetPos = new THREE.Vector3();

  // Battle state
  private battleTimer = 0;
  private battleIndex = 0;
  private currentBattleId: string | null = null;
  private battleTargetPos = new THREE.Vector3();
  private battleEndTimer = 0;
  private previousBattleIds = new Set<string>();

  // KO zoom state
  private koZooming = false;
  private koTimer = 0;
  private koTargetPos = new THREE.Vector3();

  // Shared
  private orbitAngle = 0;
  private desiredTarget = new THREE.Vector3();
  private desiredCamPos = new THREE.Vector3();

  // Track user interaction to auto-disable
  private userInteracted = false;
  private interactionBound = false;

  // Listeners
  private onChangeHandler: (() => void) | null = null;

  constructor(deps: AutoCamDeps) {
    this.deps = deps;
  }

  /* ── Public API ─────────────────────────────────────────────── */

  isEnabled(): boolean {
    return this.enabled;
  }

  getMode(): AutoCamMode {
    return this.mode;
  }

  toggle(): boolean {
    if (this.enabled) {
      this.disable();
    } else {
      this.enable();
    }
    return this.enabled;
  }

  enable(): void {
    this.enabled = true;
    this.userInteracted = false;
    this.roamTimer = 0;
    this.battleTimer = 0;
    this.orbitAngle = Math.atan2(
      this.deps.camera.position.x - this.deps.controls.target.x,
      this.deps.camera.position.z - this.deps.controls.target.z,
    );
    this.bindInteractionListeners();
  }

  disable(): void {
    this.enabled = false;
    this.koZooming = false;
    this.unbindInteractionListeners();
  }

  /** Call when a battle ends — triggers KO zoom if autocam is on */
  notifyBattleEnd(defeatedPos: THREE.Vector3 | null): void {
    if (!this.enabled || !defeatedPos) return;
    this.koZooming = true;
    this.koTimer = 0;
    this.koTargetPos.copy(defeatedPos);
  }

  /** Notify that a new battle started */
  notifyBattleStart(): void {
    if (!this.enabled) return;
    // Immediately switch to battle mode
    this.mode = "battle";
    this.battleTimer = 0;
  }

  /* ── Frame Update ───────────────────────────────────────────── */

  update(delta: number): void {
    if (!this.enabled) return;

    // User grabbed the controls — disable autocam
    if (this.userInteracted) {
      this.disable();
      return;
    }

    this.orbitAngle += (this.mode === "battle" ? BATTLE_ORBIT_SPEED : ROAM_ORBIT_SPEED) * delta;

    // KO zoom overrides everything
    if (this.koZooming) {
      this.updateKoZoom(delta);
      this.applyCameraSmooth(delta, 0.08);
      return;
    }

    // Check if there are active battles
    const battles = this.deps.getActiveBattles();
    if (battles.length > 0) {
      this.mode = "battle";
      this.updateBattleMode(delta, battles);
    } else {
      // Linger after last battle ends
      if (this.mode === "battle") {
        this.battleEndTimer += delta;
        if (this.battleEndTimer >= BATTLE_END_LINGER) {
          this.mode = "roam";
          this.battleEndTimer = 0;
          this.roamTimer = 0; // pick a new agent soon
        }
      }
      if (this.mode === "roam") {
        this.updateRoamMode(delta);
      }
    }

    const lerpSpeed = this.mode === "battle" ? BATTLE_LERP_SPEED : ROAM_LERP_SPEED;
    this.applyCameraSmooth(delta, lerpSpeed);
  }

  /* ── Roam Mode ──────────────────────────────────────────────── */

  private updateRoamMode(delta: number): void {
    this.roamTimer += delta;

    const agents = this.deps.getAgentPositions();
    if (agents.size === 0) {
      // No agents — orbit world center
      this.desiredTarget.set(0, 2, 0);
      this.desiredCamPos.set(
        Math.sin(this.orbitAngle) * ROAM_ORBIT_RADIUS * 1.5,
        ROAM_ORBIT_HEIGHT * 1.5,
        Math.cos(this.orbitAngle) * ROAM_ORBIT_RADIUS * 1.5,
      );
      return;
    }

    // Time to pick a new agent?
    if (this.roamTimer >= ROAM_SWITCH_INTERVAL || !this.roamTargetId || !agents.has(this.roamTargetId)) {
      this.roamTimer = 0;
      const ids = Array.from(agents.keys());
      // Pick a different agent if possible
      let nextId = ids[Math.floor(Math.random() * ids.length)];
      if (ids.length > 1 && nextId === this.roamTargetId) {
        nextId = ids[(ids.indexOf(nextId) + 1) % ids.length];
      }
      this.roamTargetId = nextId;
    }

    const pos = agents.get(this.roamTargetId!);
    if (pos) {
      this.roamTargetPos.copy(pos);
    }

    this.desiredTarget.set(this.roamTargetPos.x, this.roamTargetPos.y + 2, this.roamTargetPos.z);
    this.desiredCamPos.set(
      this.roamTargetPos.x + Math.sin(this.orbitAngle) * ROAM_ORBIT_RADIUS,
      this.roamTargetPos.y + ROAM_ORBIT_HEIGHT,
      this.roamTargetPos.z + Math.cos(this.orbitAngle) * ROAM_ORBIT_RADIUS,
    );
  }

  /* ── Battle Spectator Mode ─────────────────────────────────── */

  private updateBattleMode(delta: number, battles: BattleFocus[]): void {
    this.battleTimer += delta;
    this.battleEndTimer = 0;

    // Cycle between battles
    if (battles.length > 1 && this.battleTimer >= BATTLE_CYCLE_INTERVAL) {
      this.battleTimer = 0;
      this.battleIndex = (this.battleIndex + 1) % battles.length;
    }

    // Clamp index
    if (this.battleIndex >= battles.length) {
      this.battleIndex = 0;
    }

    const battle = battles[this.battleIndex];
    this.currentBattleId = battle.battleId;
    this.battleTargetPos.copy(battle.midpoint);

    this.desiredTarget.set(
      this.battleTargetPos.x,
      this.battleTargetPos.y + 1.5,
      this.battleTargetPos.z,
    );
    this.desiredCamPos.set(
      this.battleTargetPos.x + Math.sin(this.orbitAngle) * BATTLE_ORBIT_RADIUS,
      this.battleTargetPos.y + BATTLE_ORBIT_HEIGHT,
      this.battleTargetPos.z + Math.cos(this.orbitAngle) * BATTLE_ORBIT_RADIUS,
    );
  }

  /* ── KO Zoom ────────────────────────────────────────────────── */

  private updateKoZoom(delta: number): void {
    this.koTimer += delta;

    this.desiredTarget.set(this.koTargetPos.x, this.koTargetPos.y + 1, this.koTargetPos.z);
    this.desiredCamPos.set(
      this.koTargetPos.x + Math.sin(this.orbitAngle * 0.3) * KO_ZOOM_RADIUS,
      this.koTargetPos.y + KO_ZOOM_HEIGHT,
      this.koTargetPos.z + Math.cos(this.orbitAngle * 0.3) * KO_ZOOM_RADIUS,
    );

    if (this.koTimer >= KO_HOLD_DURATION) {
      this.koZooming = false;
      this.koTimer = 0;
    }
  }

  /* ── Smooth Camera Application ─────────────────────────────── */

  private applyCameraSmooth(_delta: number, lerpFactor: number): void {
    const { controls, camera } = this.deps;

    controls.target.lerp(this.desiredTarget, lerpFactor);
    camera.position.lerp(this.desiredCamPos, lerpFactor);
  }

  /* ── User Interaction Detection ─────────────────────────────── */

  private bindInteractionListeners(): void {
    if (this.interactionBound) return;
    this.interactionBound = true;

    // OrbitControls fires "start" when user grabs
    this.onChangeHandler = () => {
      this.userInteracted = true;
    };
    this.deps.controls.addEventListener("start", this.onChangeHandler);
  }

  private unbindInteractionListeners(): void {
    if (!this.interactionBound) return;
    this.interactionBound = false;

    if (this.onChangeHandler) {
      this.deps.controls.removeEventListener("start", this.onChangeHandler);
      this.onChangeHandler = null;
    }
  }

  dispose(): void {
    this.unbindInteractionListeners();
  }
}
