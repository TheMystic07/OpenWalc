import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { PROXIMITY_RADIUS, type BattleIntent } from "../../server/types.js";

interface LabelEntry {
  object: CSS2DObject;
  agentId: string;
}

interface BubbleEntry {
  object: CSS2DObject;
  agentId: string;
  expiresAt: number;
}

interface EmoteEntry {
  object: CSS2DObject;
  agentId: string;
  expiresAt: number;
}

interface CombatIndicatorEntry {
  object: CSS2DObject;
  agentId: string;
}

interface CombatHpEntry {
  object: CSS2DObject;
  agentId: string;
  fillEl: HTMLDivElement;
  valueEl: HTMLSpanElement;
}

interface IntentEntry {
  object: CSS2DObject;
  agentId: string;
  expiresAt: number;
}

interface DamageEntry {
  id: number;
  object: CSS2DObject;
  agentId: string;
  expiresAt: number;
}

// Reusable vector to avoid allocation in update loop
const _worldPos = new THREE.Vector3();

/**
 * CSS2DObjects start at screen (0,0) on first frame before the renderer
 * positions them. Hide initially, then reveal after one render pass so
 * they appear directly above the character instead of flying from top-left.
 */
function deferShow(el: HTMLElement): void {
  el.style.opacity = "0";
  el.style.transition = "none";
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.transition = "opacity 0.2s ease";
      el.style.opacity = "1";
    });
  });
}

/** Properly dispose a CSS2DObject: remove DOM element + detach from scene */
function disposeCSS2D(obj: CSS2DObject): void {
  obj.element.remove();
  obj.removeFromParent();
}

/**
 * Manages CSS2D overlays: name labels, chat bubbles, emotes.
 * Labels/bubbles are proximity-based — only visible when camera is close.
 */
export class EffectsManager {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private labels = new Map<string, LabelEntry>();
  private bubbles = new Map<string, BubbleEntry>();
  private emotes = new Map<string, EmoteEntry>();
  private combatIndicators = new Map<string, CombatIndicatorEntry>();
  private combatHpBars = new Map<string, CombatHpEntry>();
  private intents = new Map<string, IntentEntry>();
  private damages = new Map<number, DamageEntry>();
  private nextDamageId = 1;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
  }

  /** Create or update a name label above a lobster */
  updateLabel(agentId: string, name: string, color: string): void {
    let entry = this.labels.get(agentId);

    if (entry) {
      const el = entry.object.element as HTMLElement;
      el.textContent = name;
      el.style.borderColor = color;
      el.style.color = color;
      return;
    }

    const el = document.createElement("div");
    el.className = "lobster-label";
    el.textContent = name;
    el.style.borderColor = color;
    el.style.color = color;
    deferShow(el);

    const obj = new CSS2DObject(el);
    obj.position.set(0, 2.8, 0);
    obj.name = `label_${agentId}`;

    entry = { object: obj, agentId };
    this.labels.set(agentId, entry);
    this.attachToAgent(agentId, obj);
  }

  /** Remove a name label */
  removeLabel(agentId: string): void {
    const entry = this.labels.get(agentId);
    if (entry) {
      disposeCSS2D(entry.object);
      this.labels.delete(agentId);
    }
  }

  /** Show a chat bubble above a lobster (auto-expires after 6s) */
  showBubble(agentId: string, text: string): void {
    this.removeBubble(agentId);

    const el = document.createElement("div");
    el.className = "chat-bubble";
    el.textContent = text.length > 80 ? text.slice(0, 80) + "\u2026" : text;
    deferShow(el);

    const obj = new CSS2DObject(el);
    obj.position.set(0, 3.6, 0);
    obj.name = `bubble_${agentId}`;

    const entry: BubbleEntry = {
      object: obj,
      agentId,
      expiresAt: Date.now() + 6000,
    };
    this.bubbles.set(agentId, entry);
    this.attachToAgent(agentId, obj);
  }

  /** Remove a chat bubble */
  removeBubble(agentId: string): void {
    const entry = this.bubbles.get(agentId);
    if (entry) {
      disposeCSS2D(entry.object);
      this.bubbles.delete(agentId);
    }
  }

  /** Toggle swords indicator above agents currently in battle */
  setCombatIndicator(agentId: string, active: boolean): void {
    const existing = this.combatIndicators.get(agentId);
    if (!active) {
      if (existing) {
        disposeCSS2D(existing.object);
        this.combatIndicators.delete(agentId);
      }
      return;
    }

    if (existing) {
      // Battle state can arrive before lobster mesh; keep re-trying attach.
      this.attachToAgent(agentId, existing.object);
      return;
    }

    const el = document.createElement("div");
    el.className = "combat-indicator";
    el.textContent = "\u2694";
    deferShow(el);

    const obj = new CSS2DObject(el);
    obj.position.set(this.getOverlayOffset(agentId, 0.72), 4.4, 0);
    obj.name = `combat_${agentId}`;
    this.combatIndicators.set(agentId, { object: obj, agentId });
    this.attachToAgent(agentId, obj);
  }

  /** HP bar above agents while they are in active combat */
  setCombatHp(agentId: string, hp: number | null): void {
    if (hp == null) {
      const existing = this.combatHpBars.get(agentId);
      if (existing) {
        disposeCSS2D(existing.object);
        this.combatHpBars.delete(agentId);
      }
      return;
    }

    const hpValue = Math.max(0, Math.min(100, Math.round(hp)));
    let entry = this.combatHpBars.get(agentId);
    if (!entry) {
      const el = document.createElement("div");
      el.className = "combat-hp";

      const valueEl = document.createElement("span");
      valueEl.className = "combat-hp-value";
      el.appendChild(valueEl);

      const trackEl = document.createElement("div");
      trackEl.className = "combat-hp-track";
      const fillEl = document.createElement("div");
      fillEl.className = "combat-hp-fill";
      trackEl.appendChild(fillEl);
      el.appendChild(trackEl);

      deferShow(el);

      const obj = new CSS2DObject(el);
      obj.position.set(this.getOverlayOffset(agentId, 0.72), 3.95, 0);
      obj.name = `combat_hp_${agentId}`;

      entry = { object: obj, agentId, fillEl, valueEl };
      this.combatHpBars.set(agentId, entry);
    }

    // Keep attempting attachment because battle events can race snapshot joins.
    this.attachToAgent(agentId, entry.object);

    entry.valueEl.textContent = `${hpValue} HP`;
    entry.fillEl.style.width = `${hpValue}%`;
    entry.fillEl.classList.toggle("combat-hp-fill-low", hpValue <= 30);
  }

  /** Short-lived intent chip above an agent for current combat turn. */
  showIntent(agentId: string, intent: BattleIntent, turn?: number): void {
    const existing = this.intents.get(agentId);
    if (existing) {
      disposeCSS2D(existing.object);
      this.intents.delete(agentId);
    }

    const el = document.createElement("div");
    el.className = "combat-intent";
    if (intent === "strike" || intent === "feint") {
      el.classList.add("combat-intent-attack");
    } else if (intent === "guard") {
      el.classList.add("combat-intent-guard");
    } else {
      el.classList.add("combat-intent-move");
    }
    el.textContent = turn ? `T${turn} ${intent.toUpperCase()}` : intent.toUpperCase();
    deferShow(el);

    const obj = new CSS2DObject(el);
    obj.position.set(this.getOverlayOffset(agentId, 0.72), 4.65, 0);
    obj.name = `intent_${agentId}_${this.nextDamageId++}`;

    this.intents.set(agentId, {
      object: obj,
      agentId,
      expiresAt: Date.now() + 900,
    });
    this.attachToAgent(agentId, obj);
  }

  /** Floating damage text above an agent on round resolution */
  showDamage(agentId: string, amount: number): void {
    const el = document.createElement("div");
    const isZero = amount <= 0;
    el.className = isZero ? "damage-pop damage-pop-block" : "damage-pop";
    el.textContent = isZero ? "BLOCK" : `-${amount}`;
    deferShow(el);

    const obj = new CSS2DObject(el);
    const offset = this.getOverlayOffset(agentId, 0.72);
    obj.position.set(offset + (Math.random() - 0.5) * 0.45, 3.7 + Math.random() * 0.4, 0);
    obj.name = `dmg_${agentId}_${this.nextDamageId}`;

    const id = this.nextDamageId++;
    this.damages.set(id, {
      id,
      object: obj,
      agentId,
      expiresAt: Date.now() + 950,
    });
    this.attachToAgent(agentId, obj);
  }

  /** Explicit KO marker to make deaths readable in-scene */
  showKO(agentId: string): void {
    const el = document.createElement("div");
    el.className = "damage-pop damage-pop-ko";
    el.textContent = "\u2620 KO";
    deferShow(el);

    const obj = new CSS2DObject(el);
    obj.position.set(this.getOverlayOffset(agentId, 0.72), 4.0, 0);
    obj.name = `ko_${agentId}_${this.nextDamageId}`;

    const id = this.nextDamageId++;
    this.damages.set(id, {
      id,
      object: obj,
      agentId,
      expiresAt: Date.now() + 1600,
    });
    this.attachToAgent(agentId, obj);
  }

  /** Show an emote icon above a lobster (auto-expires after 3s) */
  showEmote(agentId: string, emote: string): void {
    const existing = this.emotes.get(agentId);
    if (existing) {
      disposeCSS2D(existing.object);
      this.emotes.delete(agentId);
    }

    const emojiMap: Record<string, string> = {
      happy: "\u{1F60A}",
      thinking: "\u{1F914}",
      surprised: "\u{1F62E}",
      laugh: "\u{1F602}",
    };

    const el = document.createElement("div");
    el.className = "emote-bubble";
    el.textContent = emojiMap[emote] ?? "\u{1F4AC}";
    deferShow(el);

    const obj = new CSS2DObject(el);
    obj.position.set(0.5, 3.2, 0);
    obj.name = `emote_${agentId}`;

    const entry: EmoteEntry = {
      object: obj,
      agentId,
      expiresAt: Date.now() + 3000,
    };
    this.emotes.set(agentId, entry);
    this.attachToAgent(agentId, obj);
  }

  /** Remove all visual overlays for an agent (used on leave/death cleanup) */
  clearAgent(agentId: string): void {
    this.removeLabel(agentId);
    this.removeBubble(agentId);

    const emote = this.emotes.get(agentId);
    if (emote) {
      disposeCSS2D(emote.object);
      this.emotes.delete(agentId);
    }

    const combat = this.combatIndicators.get(agentId);
    if (combat) {
      disposeCSS2D(combat.object);
      this.combatIndicators.delete(agentId);
    }

    const hp = this.combatHpBars.get(agentId);
    if (hp) {
      disposeCSS2D(hp.object);
      this.combatHpBars.delete(agentId);
    }

    const intent = this.intents.get(agentId);
    if (intent) {
      disposeCSS2D(intent.object);
      this.intents.delete(agentId);
    }

    for (const [id, entry] of this.damages) {
      if (entry.agentId === agentId) {
        disposeCSS2D(entry.object);
        this.damages.delete(id);
      }
    }
  }

  /** Per-frame update: expire old bubbles/emotes, proximity check */
  update(camera: THREE.Camera): void {
    const now = Date.now();
    this.camera = camera;

    // Expire bubbles (fade out, then remove)
    for (const [id, entry] of this.bubbles) {
      if (now >= entry.expiresAt) {
        disposeCSS2D(entry.object);
        this.bubbles.delete(id);
      }
    }

    // Expire emotes
    for (const [id, entry] of this.emotes) {
      if (now >= entry.expiresAt) {
        disposeCSS2D(entry.object);
        this.emotes.delete(id);
      }
    }

    // Expire intent chips
    for (const [agentId, entry] of this.intents) {
      if (now >= entry.expiresAt) {
        disposeCSS2D(entry.object);
        this.intents.delete(agentId);
      }
    }

    // Expire floating damage / KO markers
    for (const [id, entry] of this.damages) {
      if (now >= entry.expiresAt) {
        disposeCSS2D(entry.object);
        this.damages.delete(id);
      }
    }

    // Proximity-based visibility
    const camPos = camera.position;
    for (const entry of this.labels.values()) {
      const parent = entry.object.parent;
      if (parent) {
        parent.getWorldPosition(_worldPos);
        entry.object.visible = camPos.distanceTo(_worldPos) < PROXIMITY_RADIUS;
      }
    }
    for (const entry of this.bubbles.values()) {
      const parent = entry.object.parent;
      if (parent) {
        parent.getWorldPosition(_worldPos);
        entry.object.visible = camPos.distanceTo(_worldPos) < PROXIMITY_RADIUS;
      }
    }
    for (const entry of this.combatIndicators.values()) {
      entry.object.visible = true;
    }
    for (const entry of this.combatHpBars.values()) {
      entry.object.visible = true;
    }
    for (const entry of this.intents.values()) {
      entry.object.visible = true;
    }
    for (const entry of this.damages.values()) {
      const parent = entry.object.parent;
      if (parent) {
        parent.getWorldPosition(_worldPos);
        entry.object.visible = camPos.distanceTo(_worldPos) < PROXIMITY_RADIUS;
      }
    }
  }

  /** Attach a CSS2DObject to a lobster group in the scene */
  private attachToAgent(agentId: string, obj: CSS2DObject): void {
    this.scene.traverse((child) => {
      if (child.userData.agentId === agentId && child.name === "lobster") {
        child.add(obj);
      }
    });
  }

  private getOverlayOffset(agentId: string, spread = 0.6): number {
    let hash = 0;
    for (let i = 0; i < agentId.length; i++) {
      hash = (hash * 33 + agentId.charCodeAt(i)) >>> 0;
    }
    const normalized = (hash % 1000) / 999; // [0, 1]
    return (normalized - 0.5) * spread;
  }
}
