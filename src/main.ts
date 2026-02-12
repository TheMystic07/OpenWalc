import { createScene } from "./scene/room.js";
import { LobsterManager } from "./scene/lobster-manager.js";
import { ParticleEngine } from "./scene/particle-engine.js";
import { EffectsManager } from "./scene/effects.js";
import { createBuildings } from "./scene/buildings.js";
import { WSClient } from "./net/ws-client.js";
import { setupOverlay } from "./ui/overlay.js";
import { setupChatLog } from "./ui/chat-log.js";
import { setupBattlePanel } from "./ui/battle-panel.js";
import { setupProfilePanel } from "./ui/profile-panel.js";
import * as THREE from "three";
import type {
  AgentProfile,
  AgentState,
  WorldMessage,
  BattleIntent,
  BattleStateSummary,
} from "../server/types.js";

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  }
}

// ── Parse URL params ───────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
const focusAgent = params.get("agent");

// ── Global server base URL (for API calls from building panels etc.) ──

/** Empty string for local (Vite proxy), or full URL for remote */

// ── Scene setup (immediate — no lobby) ────────────────────────

const { scene, camera, renderer, labelRenderer, controls, clock, terrainReady } = createScene();

// Add interactive world building(s) to the scene
const { buildings, obstacles: buildingObstacles } = createBuildings(scene);

const particleEngine = new ParticleEngine(scene);
const lobsterManager = new LobsterManager(scene, buildingObstacles, particleEngine);

// Terrain models load asynchronously — feed obstacles to lobster manager when ready
terrainReady.then((terrainObstacles) => {
  lobsterManager.addObstacles(terrainObstacles);
  console.log(`[main] Terrain ready: ${terrainObstacles.length} obstacles added`);
}).catch((err) => {
  console.warn("[main] Terrain loading failed:", err);
});
const effects = new EffectsManager(scene, camera);

// ── UI ─────────────────────────────────────────────────────────

const overlay = setupOverlay();
const chatLog = setupChatLog();
chatLog.setNameResolver((agentId: string) => {
  const profile = overlay.getAgent(agentId);
  return profile?.name ?? agentId;
});
const battlePanel = setupBattlePanel((agentId: string) => {
  const profile = overlay.getAgent(agentId);
  return profile?.name ?? agentId;
});
const profilePanel = setupProfilePanel((agentId: string) => {
  // Click callback → focus camera on lobster
  const pos = lobsterManager.getPosition(agentId);
  if (pos) {
    controls.target.set(pos.x, pos.y + 2, pos.z);
  }
});

// ── WebSocket connection ───────────────────────────────────────

const ws = new WSClient();
const activeCombatants = new Set<string>();

function fallbackJoinPosition(agentId: string, timestamp: number): {
  agentId: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  timestamp: number;
} {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  const angle = (hash % 360) * (Math.PI / 180);
  const radius = 10 + (hash % 22);
  return {
    agentId,
    x: Math.cos(angle) * radius,
    y: 0,
    z: Math.sin(angle) * radius,
    rotation: ((hash % 628) / 100),
    timestamp,
  };
}

function syncCombatVisualsFromBattles(battles: BattleStateSummary[]): void {
  const next = new Set<string>();
  const hpByAgent = new Map<string, number>();
  const staminaByAgent = new Map<string, number>();

  for (const battle of battles) {
    for (const agentId of battle.participants) {
      next.add(agentId);
      hpByAgent.set(agentId, Math.max(0, Math.min(100, battle.hp[agentId] ?? 0)));
      if (battle.stamina) {
        staminaByAgent.set(agentId, Math.max(0, Math.min(100, battle.stamina[agentId] ?? 100)));
      }
    }
  }

  for (const agentId of activeCombatants) {
    if (next.has(agentId)) continue;
    activeCombatants.delete(agentId);
    lobsterManager.setCombatState(agentId, false);
    effects.setCombatIndicator(agentId, false);
    effects.setCombatHp(agentId, null);
    effects.setCombatStamina(agentId, null);
  }

  for (const agentId of next) {
    if (!activeCombatants.has(agentId)) {
      activeCombatants.add(agentId);
      lobsterManager.setCombatState(agentId, true);
      effects.setCombatIndicator(agentId, true);
    }
    effects.setCombatHp(agentId, hpByAgent.get(agentId) ?? 0);
    effects.setCombatStamina(agentId, staminaByAgent.get(agentId) ?? 100);
  }
}

// Bridge connection events to window for overlay status dot
let profileRefreshInterval: ReturnType<typeof setInterval> | null = null;
const seenChatMessageKeys = new Set<string>();

ws.on("connected", () => {
  window.dispatchEvent(new CustomEvent("ws:connected"));
  // Request full (non-AOI-filtered) profiles for the overlay agent list
  ws.requestProfiles();
  ws.requestBattles();
  // Periodically refresh agent list (every 30s) to catch joins/leaves
  if (profileRefreshInterval) clearInterval(profileRefreshInterval);
  profileRefreshInterval = setInterval(() => ws.requestProfiles(), 30_000);
});
ws.on("disconnected", () => {
  window.dispatchEvent(new CustomEvent("ws:disconnected"));
  if (profileRefreshInterval) {
    clearInterval(profileRefreshInterval);
    profileRefreshInterval = null;
  }
});

ws.on("snapshot", (_raw) => {
  const data = _raw as { agents: AgentState[] };
  for (const agent of data.agents) {
    lobsterManager.addOrUpdate(agent.profile, agent.position);
    effects.updateLabel(agent.profile.agentId, agent.profile.name, agent.profile.color);
  }
  // Note: overlay agent list is updated via requestProfiles + join/leave,
  // NOT from snapshots (which are AOI-filtered and would hide distant agents).

  // Auto-focus in preview mode
  if (focusAgent) {
    const pos = lobsterManager.getPosition(focusAgent);
    if (pos) {
      controls.target.set(pos.x, pos.y + 2, pos.z);
      camera.position.set(pos.x + 10, pos.y + 8, pos.z + 10);
    }
  }
});

ws.on("world", (_raw) => {
  const data = _raw as { message: WorldMessage };
  const msg = data.message;

  const intentToAction = (intent: BattleIntent): string => {
    switch (intent) {
      case "strike":
        return "strike";
      case "feint":
        return "feint";
      case "guard":
        return "guard";
      case "approach":
        return "approach";
      case "retreat":
        return "retreat";
      default:
        return "walk";
    }
  };

  switch (msg.worldType) {
    case "position":
      lobsterManager.updatePosition(msg.agentId, msg);
      break;

    case "action":
      lobsterManager.setAction(msg.agentId, msg.action);
      break;

    case "join":
      {
        const pos = (
          Number.isFinite(msg.x) &&
          Number.isFinite(msg.z) &&
          Number.isFinite(msg.rotation)
        )
          ? {
              agentId: msg.agentId,
              x: Number(msg.x),
              y: Number.isFinite(msg.y) ? Number(msg.y) : 0,
              z: Number(msg.z),
              rotation: Number(msg.rotation),
              timestamp: msg.timestamp,
            }
          : fallbackJoinPosition(msg.agentId, msg.timestamp);
      lobsterManager.addOrUpdate(
        {
          agentId: msg.agentId,
          name: msg.name,
          walletAddress: msg.walletAddress ?? "",
          color: msg.color,
          bio: msg.bio,
          capabilities: msg.capabilities,
          pubkey: "",
          joinedAt: msg.timestamp,
          lastSeen: msg.timestamp,
        },
        pos
      );
      effects.updateLabel(msg.agentId, msg.name, msg.color);
      chatLog.addSystem(`${msg.name} joined the ocean world`);
      overlay.addAgent({
        agentId: msg.agentId,
        name: msg.name,
        walletAddress: msg.walletAddress ?? "",
        pubkey: "",
        bio: msg.bio,
        capabilities: msg.capabilities,
        color: msg.color,
        joinedAt: msg.timestamp,
        lastSeen: msg.timestamp,
      });
      break;
      }

    case "leave":
      lobsterManager.remove(msg.agentId);
      effects.clearAgent(msg.agentId);
      chatLog.addSystem(`Agent ${msg.agentId} left`);
      overlay.removeAgent(msg.agentId);
      activeCombatants.delete(msg.agentId);
      break;

    case "chat":
      effects.showBubble(msg.agentId, msg.text);
      {
        const key = `${msg.agentId}:${msg.timestamp}:${msg.text}`;
        if (!seenChatMessageKeys.has(key)) {
          seenChatMessageKeys.add(key);
          while (seenChatMessageKeys.size > 500) {
            const first = seenChatMessageKeys.values().next().value;
            if (!first) break;
            seenChatMessageKeys.delete(first);
          }
          chatLog.addMessage(msg.agentId, msg.text);
        }
      }
      break;

    case "emote":
      effects.showEmote(msg.agentId, msg.emote);
      break;

    case "profile":
      effects.updateLabel(msg.agentId, msg.name, msg.color);
      {
        const prev = overlay.getAgent(msg.agentId);
      overlay.updateAgent({
        agentId: msg.agentId,
        name: msg.name,
        walletAddress: prev?.walletAddress ?? "",
        bio: msg.bio,
        capabilities: msg.capabilities,
        color: msg.color,
        pubkey: "",
        joinedAt: prev?.joinedAt ?? 0,
        lastSeen: Date.now(),
      });
      }
      break;

    case "battle":
      battlePanel.applyEvent(msg);
      syncCombatVisualsFromBattles(battlePanel.getSnapshot());

      // Only show deaths/KOs in world chat — not every battle tick
      if (msg.phase === "ended" && msg.defeatedIds && msg.defeatedIds.length > 0) {
        for (const deadId of msg.defeatedIds) {
          const deadName = overlay.getAgent(deadId)?.name ?? deadId;
          const killerName = msg.winnerId
            ? (overlay.getAgent(msg.winnerId)?.name ?? msg.winnerId)
            : "unknown";
          chatLog.addBattle(`${deadName} was eliminated by ${killerName}!`);
        }
      }

      if (msg.phase === "started") {
        for (const agentId of msg.participants) {
          lobsterManager.triggerAction(agentId, "approach", 520);
          // Battle start burst particles
          const pos = lobsterManager.getPosition(agentId);
          if (pos) {
            particleEngine.emit("battleStart", pos);
            particleEngine.emitRing("battleStart", pos);
          }
        }
      }

      if (msg.phase === "intent" && msg.actorId && msg.intent) {
        const action = intentToAction(msg.intent);
        lobsterManager.triggerAction(msg.actorId, action, 900);
        effects.showIntent(msg.actorId, msg.intent, msg.turn);
        // Guard shield particles
        if (msg.intent === "guard") {
          const pos = lobsterManager.getPosition(msg.actorId);
          if (pos) {
            particleEngine.emit("guard", pos);
            particleEngine.emitRing("guard", pos);
          }
        }
        if (msg.intent === "strike" || msg.intent === "feint") {
          const pos = lobsterManager.getPosition(msg.actorId);
          if (pos) {
            particleEngine.emit("spark", pos);
            particleEngine.emit("slash", pos);
            particleEngine.emitRing("slash", pos);
          }
        }
      }

      if (msg.phase === "round" && msg.intents) {
        for (const [agentId, intent] of Object.entries(msg.intents)) {
          if (!intent) continue;
          lobsterManager.triggerAction(agentId, intentToAction(intent), 820);
          effects.showIntent(agentId, intent, msg.turn);
          // Guard shield particles on round resolve
          if (intent === "guard") {
            const pos = lobsterManager.getPosition(agentId);
            if (pos) {
              particleEngine.emit("guard", pos);
              particleEngine.emitRing("guard", pos);
            }
          }
          if (intent === "strike" || intent === "feint") {
            const pos = lobsterManager.getPosition(agentId);
            if (pos) {
              particleEngine.emit("slash", pos);
              particleEngine.emitRing("slash", pos);
            }
          }
        }

        const recipients = msg.participants ?? [];
        for (const agentId of recipients) {
          const normalized = Math.max(0, Number(msg.damage?.[agentId] ?? 0) || 0);
          effects.showDamage(agentId, normalized);
          if (normalized > 0) {
            lobsterManager.pulseImpact(agentId);
            lobsterManager.triggerAction(agentId, "stunned", 420);
          }
        }

        // Stamina update
        if (msg.stamina) {
          for (const agentId of recipients) {
            effects.setCombatStamina(agentId, msg.stamina[agentId] ?? 100);
          }
        }

        // Read bonus visual
        if (msg.readBonus) {
          for (const [agentId, bonus] of Object.entries(msg.readBonus)) {
            if (bonus > 0) {
              effects.showReadBonus(agentId);
            }
          }
        }

        // Timeout warnings
        if (msg.timedOut) {
          for (const agentId of msg.timedOut) {
            effects.showTimeout(agentId);
          }
        }
      }

      if (msg.phase === "ended") {
        for (const agentId of msg.participants) {
          lobsterManager.setAction(agentId, "idle");
          effects.setCombatStamina(agentId, null);
        }
        if (msg.winnerId) {
          lobsterManager.triggerAction(msg.winnerId, "victory", 1700);
        }
        for (const defeatedId of msg.defeatedIds ?? []) {
          lobsterManager.setDeadState(defeatedId, true);
          effects.showKO(defeatedId);
        }
        // Flee visuals: smoke puff on the fleeing agent
        if (msg.reason === "flee") {
          for (const agentId of msg.participants) {
            const pos = lobsterManager.getPosition(agentId);
            if (pos) {
              particleEngine.emit("flee", pos);
              particleEngine.emitRing("flee", pos);
            }
            effects.showFlee(agentId);
          }
        }
        // Truce visuals: green burst on both agents
        if (msg.reason === "truce") {
          for (const agentId of msg.participants) {
            const pos = lobsterManager.getPosition(agentId);
            if (pos) {
              particleEngine.emit("truce", pos);
              particleEngine.emitRing("truce", pos);
            }
            effects.showTruce(agentId);
          }
        }
      }
      break;
  }
});

ws.on("profiles", (_raw) => {
  const data = _raw as { profiles: AgentProfile[] };
  overlay.updateAgentList(data.profiles);
});

ws.on("battleState", (_raw) => {
  const data = _raw as { battles: BattleStateSummary[] };
  battlePanel.setBattles(data.battles);
  syncCombatVisualsFromBattles(battlePanel.getSnapshot());
});

ws.connect();

// ── Click to select lobster or building ────────────────────────

const pickRaycaster = new THREE.Raycaster();
const pickPointer = new THREE.Vector2();

renderer.domElement.addEventListener("click", (event: MouseEvent) => {
  // First check for building clicks
  const rect = renderer.domElement.getBoundingClientRect();
  pickPointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pickPointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  pickRaycaster.setFromCamera(pickPointer, camera);

  // Collect building meshes
  const buildingMeshes: THREE.Mesh[] = [];
  for (const b of buildings) {
    b.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) buildingMeshes.push(child);
    });
  }
  const buildingHits = pickRaycaster.intersectObjects(buildingMeshes, false);
  if (buildingHits.length > 0) {
    let obj: THREE.Object3D | null = buildingHits[0].object;
    while (obj) {
      if (obj.userData.buildingId === "moltbook") {
        window.open("https://www.moltbook.com", "_blank", "noopener");
        return;
      }
      obj = obj.parent;
    }
  }

  // Then check for lobster clicks
  const agentId = lobsterManager.pick(event, camera, renderer.domElement);
  if (agentId) {
    const profile = overlay.getAgent(agentId);
    if (profile) {
      profilePanel.show(profile);
      const pos = lobsterManager.getPosition(agentId);
      if (pos) {
        controls.target.set(pos.x, pos.y + 2, pos.z);
      }
    }
  }
});

// ── Camera follow ─────────────────────────────────────────────

let followAgentId: string | null = focusAgent;

window.addEventListener("agent:select", ((e: CustomEvent<{ agentId: string }>) => {
  const agentId = e.detail.agentId;
  if (followAgentId === agentId) {
    // Click again to unfollow
    followAgentId = null;
  } else {
    followAgentId = agentId;
    // Snap camera to agent immediately
    const pos = lobsterManager.getPosition(agentId);
    if (pos) {
      controls.target.set(pos.x, pos.y + 2, pos.z);
    }
  }
}) as EventListener);

// Clicking on the 3D scene (not on an agent) unfollows
renderer.domElement.addEventListener("dblclick", () => {
  followAgentId = null;
});

// ── Animation loop ─────────────────────────────────────────────

let viewportReportTimer = 0;
const VIEWPORT_REPORT_INTERVAL = 1.0; // seconds

function stepFrame(delta: number): void {
  lobsterManager.update(delta);
  effects.update(camera);

  // Follow agent: smoothly track their position
  if (followAgentId) {
    const pos = lobsterManager.getPosition(followAgentId);
    if (pos) {
      const target = controls.target;
      target.lerp(new THREE.Vector3(pos.x, pos.y + 2, pos.z), 0.08);
    }
  }

  controls.update();

  // Report camera position to server for AOI filtering (every 1s)
  viewportReportTimer += delta;
  if (viewportReportTimer >= VIEWPORT_REPORT_INTERVAL) {
    viewportReportTimer = 0;
    const target = controls.target;
    ws.reportViewport(target.x, target.z);
  }

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

function animate() {
  requestAnimationFrame(animate);
  stepFrame(clock.getDelta());
}

window.render_game_to_text = () => {
  const agents = lobsterManager.getAgentIds().map((agentId) => {
    const pos = lobsterManager.getPosition(agentId);
    return {
      agentId,
      name: overlay.getAgent(agentId)?.name ?? agentId,
      x: Number((pos?.x ?? 0).toFixed(2)),
      y: Number((pos?.y ?? 0).toFixed(2)),
      z: Number((pos?.z ?? 0).toFixed(2)),
    };
  });

  return JSON.stringify({
    coordinateSystem: "origin at room center; +x right, +z toward front wall, +y up",
    followAgentId,
    cameraTarget: {
      x: Number(controls.target.x.toFixed(2)),
      y: Number(controls.target.y.toFixed(2)),
      z: Number(controls.target.z.toFixed(2)),
    },
    agents,
    activeBattles: battlePanel.getSnapshot(),
    recentChat: chatLog.getRecent(6),
  });
};

window.advanceTime = (ms: number) => {
  const steps = Math.max(1, Math.round(ms / (1000 / 60)));
  const stepDelta = (ms / 1000) / steps;
  for (let i = 0; i < steps; i++) {
    stepFrame(stepDelta);
  }
};

animate();

// ── Resize handler ─────────────────────────────────────────────

window.addEventListener("resize", () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
});
