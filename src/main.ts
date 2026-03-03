import { createScene } from "./scene/room.js";
import { loadLobsterModel } from "./scene/lobster.js";
import { LobsterManager } from "./scene/lobster-manager.js";
import { ParticleEngine } from "./scene/particle-engine.js";
import { EffectsManager } from "./scene/effects.js";
import { createBuildings } from "./scene/buildings.js";
import { AutoCam, type BattleFocus } from "./scene/autocam.js";
import { WSClient } from "./net/ws-client.js";
import type { ConnectedSolanaWallet } from "./net/solana-wallet.js";
import { setupOverlay, type BetOddsEntry } from "./ui/overlay.js";
import { setupChatLog } from "./ui/chat-log.js";
import { setupBattlePanel } from "./ui/battle-panel.js";
import { setupProfilePanel } from "./ui/profile-panel.js";
import { setupLiveHud } from "./ui/live-hud.js";
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

interface PublicBettingConfigPayload {
  adminWallet?: unknown;
  minBet?: unknown;
  closed?: unknown;
  totalPool?: unknown;
  odds?: unknown;
  currency?: unknown;
  rpcUrl?: unknown;
}

interface PublicConfigResponse {
  ok?: boolean;
  betting?: PublicBettingConfigPayload;
}

// ── Global server base URL (for API calls from building panels etc.) ──

/** Empty string for local (Vite proxy), or full URL for remote */

// ── Scene setup (immediate — no lobby) ────────────────────────

const { scene, camera, renderer, labelRenderer, controls, clock, terrainReady } = createScene();

// Kick off GLTF lobster model load early (LobsterManager awaits this internally)
loadLobsterModel().catch((err) => console.warn("[main] Lobster model load failed:", err));

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

// ── AutoCam ─────────────────────────────────────────────────────
const autoCam = new AutoCam({
  camera,
  controls,
  getAgentPositions(): Map<string, THREE.Vector3> {
    const map = new Map<string, THREE.Vector3>();
    for (const id of lobsterManager.getAgentIds()) {
      const pos = lobsterManager.getPosition(id);
      if (pos) map.set(id, pos);
    }
    return map;
  },
  getActiveBattles(): BattleFocus[] {
    const battles = battlePanel.getSnapshot();
    const result: BattleFocus[] = [];
    for (const b of battles) {
      const [aId, bId] = b.participants;
      const posA = lobsterManager.getPosition(aId);
      const posB = lobsterManager.getPosition(bId);
      if (posA && posB) {
        result.push({
          battleId: b.battleId,
          participants: b.participants,
          midpoint: new THREE.Vector3(
            (posA.x + posB.x) / 2,
            (posA.y + posB.y) / 2,
            (posA.z + posB.z) / 2,
          ),
        });
      }
    }
    return result;
  },
});

let connectedWallet: ConnectedSolanaWallet | null = null;
let solanaWalletModulePromise: Promise<typeof import("./net/solana-wallet.js")> | null = null;
const bettingClientConfig = {
  adminWallet: "",
  currency: "SOL",
  minBet: 0.000000001,
  rpcUrl: window.location.protocol === "https:"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.mainnet-beta.solana.com",
};

function loadSolanaWalletModule(): Promise<typeof import("./net/solana-wallet.js")> {
  if (!solanaWalletModulePromise) {
    solanaWalletModulePromise = import("./net/solana-wallet.js");
  }
  return solanaWalletModulePromise;
}

// ── UI ─────────────────────────────────────────────────────────

const overlay = setupOverlay();
const chatLog = setupChatLog();
const liveHud = setupLiveHud();
chatLog.setNameResolver((agentId: string) => {
  const profile = overlay.getAgent(agentId);
  return profile?.name ?? agentId;
});
const battlePanel = setupBattlePanel((agentId: string) => {
  const profile = overlay.getAgent(agentId);
  return profile?.name ?? agentId;
});

function refreshHudCounts(): void {
  liveHud.setCounts({
    agents: overlay.getCount(),
    battles: battlePanel.getSnapshot().length,
  });
}

function displayName(agentId: string): string {
  return overlay.getAgent(agentId)?.name ?? agentId;
}

function shortWallet(wallet: string): string {
  if (!wallet) return "unknown";
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

function normalizeBetOdds(value: unknown): BetOddsEntry[] {
  if (!Array.isArray(value)) return [];
  const rows: BetOddsEntry[] = [];
  for (const raw of value) {
    const row = raw as { agentId?: unknown; totalBet?: unknown; odds?: unknown };
    if (typeof row?.agentId !== "string" || row.agentId.length === 0) continue;
    const totalBet = Number(row.totalBet);
    const odds = Number(row.odds);
    rows.push({
      agentId: row.agentId,
      totalBet: Number.isFinite(totalBet) ? Math.max(0, totalBet) : 0,
      odds: Number.isFinite(odds) ? Math.max(0, odds) : 0,
    });
  }
  return rows.sort((a, b) => b.totalBet - a.totalBet);
}

function mergeOddsWithBet(agentId: string, amount: number, totalPool: number): BetOddsEntry[] {
  const current = overlay.getBettingSnapshot();
  const totals = new Map<string, number>();
  for (const row of current.odds) {
    totals.set(row.agentId, Math.max(0, row.totalBet));
  }
  totals.set(agentId, (totals.get(agentId) ?? 0) + Math.max(0, amount));
  return Array.from(totals.entries())
    .map(([nextAgentId, totalBet]) => ({
      agentId: nextAgentId,
      totalBet,
      odds: totalBet > 0 ? totalPool / totalBet : 0,
    }))
    .sort((a, b) => b.totalBet - a.totalBet);
}

async function refreshBettingSnapshot(): Promise<void> {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return;
    const payload = (await response.json()) as PublicConfigResponse;
    const betting = payload?.betting;
    if (!betting || typeof betting !== "object") return;

    if (typeof betting.adminWallet === "string" && betting.adminWallet.length > 0) {
      bettingClientConfig.adminWallet = betting.adminWallet;
    }
    if (typeof betting.currency === "string" && betting.currency.length > 0) {
      bettingClientConfig.currency = betting.currency.toUpperCase();
    }
    if (Number.isFinite(Number(betting.minBet))) {
      bettingClientConfig.minBet = Math.max(0.000000001, Number(betting.minBet));
    }
    if (typeof betting.rpcUrl === "string" && betting.rpcUrl.length > 0) {
      bettingClientConfig.rpcUrl = betting.rpcUrl;
    }

    overlay.setBettingSnapshot({
      closed: typeof betting.closed === "boolean" ? betting.closed : undefined,
      totalPool: Number.isFinite(Number(betting.totalPool)) ? Number(betting.totalPool) : undefined,
      minBet: Number.isFinite(Number(betting.minBet)) ? Number(betting.minBet) : undefined,
      adminWallet: typeof betting.adminWallet === "string" ? betting.adminWallet : undefined,
      odds: normalizeBetOdds(betting.odds),
    });
    profilePanel.setBettingSnapshot({
      closed: typeof betting.closed === "boolean" ? betting.closed : undefined,
      minBet: bettingClientConfig.minBet,
      currency: bettingClientConfig.currency,
    });
  } catch {
    // Best-effort fetch only; websocket updates still keep betting live.
  }
}
const profilePanel = setupProfilePanel({
  onFocusAgent(agentId: string) {
    const pos = lobsterManager.getPosition(agentId);
    if (pos) {
      controls.target.set(pos.x, pos.y + 2, pos.z);
    }
  },
  async onConnectWallet() {
    const walletModule = await loadSolanaWalletModule();
    const wallet = await walletModule.connectInjectedSolanaWallet();
    connectedWallet = wallet;
    overlay.setConnectedWallet(wallet.address, wallet.providerLabel);
    profilePanel.setConnectedWallet(wallet.address, wallet.providerLabel);
    return {
      wallet: wallet.address,
      providerLabel: wallet.providerLabel,
    };
  },
  async onBetAgent({ agentId, wallet, amount }) {
    if (!connectedWallet) {
      throw new Error("Connect wallet first.");
    }
    const normalizedWallet = wallet.trim();
    if (!connectedWallet.address || connectedWallet.address !== normalizedWallet) {
      throw new Error("Connected wallet does not match current wallet.");
    }
    if (!bettingClientConfig.adminWallet) {
      throw new Error("Betting token settings are not available yet.");
    }
    if (!Number.isFinite(amount) || amount < bettingClientConfig.minBet) {
      throw new Error(`Minimum bet is ${bettingClientConfig.minBet.toFixed(9)} ${bettingClientConfig.currency}.`);
    }

    profilePanel.setBettingPending(true);
    overlay.setBettingPending(true);
    profilePanel.setBettingFeedback(`Sending ${bettingClientConfig.currency} transfer via wallet...`, "neutral");

    const walletModule = await loadSolanaWalletModule();
    let txHash: string;
    try {
      txHash = await walletModule.sendSolTransferViaWallet({
        connectionUrl: bettingClientConfig.rpcUrl,
        provider: connectedWallet.provider,
        adminWallet: bettingClientConfig.adminWallet,
        amount,
      });
    } catch (error) {
      profilePanel.setBettingPending(false);
      overlay.setBettingPending(false);
      throw error;
    }

    ws.placeBet(agentId, amount, txHash, wallet);
  },
});

const matchStateBannerEl = document.getElementById("match-state-banner");

function setMatchBannerState(text: string, tone: "waiting" | "ended" | "live", visible: boolean): void {
  if (!matchStateBannerEl) return;
  matchStateBannerEl.textContent = text;
  matchStateBannerEl.classList.toggle("visible", visible);
  matchStateBannerEl.classList.toggle("match-waiting", tone === "waiting");
  matchStateBannerEl.classList.toggle("match-ended", tone === "ended");
  matchStateBannerEl.classList.toggle("match-live", tone === "live");
}

interface MatchRecentRound {
  status?: string;
  winnerAgentIds?: string[];
  winnerNames?: string[];
  summary?: string;
}

function describeRecentRound(round?: MatchRecentRound): string {
  if (!round) return "";
  const winnerNames = Array.isArray(round.winnerNames) && round.winnerNames.length > 0
    ? round.winnerNames
    : Array.isArray(round.winnerAgentIds) && round.winnerAgentIds.length > 0
      ? round.winnerAgentIds.map((agentId) => displayName(agentId))
      : [];
  const winnerLabel = winnerNames.length > 0
    ? `Last winner${winnerNames.length > 1 ? "s" : ""}: ${winnerNames.join(", ")}.`
    : "Last match had no winner.";
  const summary = typeof round.summary === "string" && round.summary.trim().length > 0
    ? ` ${round.summary.trim()}`
    : "";
  return `${winnerLabel}${summary}`.trim();
}

function updateMatchStateBanner(survival?: {
  status?: string;
  winnerAgentId?: string;
  winnerAgentIds?: string[];
  summary?: string;
  recentRounds?: MatchRecentRound[];
}): void {
  const status = typeof survival?.status === "string" ? survival.status : "";
  const recentRound = Array.isArray(survival?.recentRounds) && survival.recentRounds.length > 0
    ? survival.recentRounds[0]
    : undefined;
  if (status === "waiting") {
    const lastRoundMessage = describeRecentRound(recentRound);
    const text = lastRoundMessage.length > 0
      ? `Match is not started yet. Waiting for admin to start. ${lastRoundMessage}`
      : "Match is not started yet. Waiting for admin to start.";
    setMatchBannerState(text, "waiting", true);
    return;
  }

  if (status === "winner" || status === "refused" || status === "timer_ended") {
    const winnerIds = Array.isArray(survival?.winnerAgentIds) && survival.winnerAgentIds.length > 0
      ? survival.winnerAgentIds
      : typeof survival?.winnerAgentId === "string" && survival.winnerAgentId.length > 0
        ? [survival.winnerAgentId]
        : [];
    const winnerNames = winnerIds.map((agentId) => displayName(agentId));
    const winnerPrefix = winnerNames.length > 0
      ? `Previous winner${winnerNames.length > 1 ? "s" : ""}: ${winnerNames.join(", ")}.`
      : "No winner in previous match.";
    const summary = typeof survival?.summary === "string" && survival.summary.trim().length > 0
      ? ` ${survival.summary.trim()}`
      : "";
    const fallbackSummary = summary.length > 0 ? `${winnerPrefix}${summary}` : winnerPrefix;
    setMatchBannerState(fallbackSummary, "ended", true);
    return;
  }

  setMatchBannerState("", "live", false);
}

type MobilePanelKey = "battle" | "chat";

interface MobilePanelController {
  setMobileOpen(open: boolean): void;
  isMobileOpen(): boolean;
}

function setupMobileHudToggles(): void {
  const mobileQuery = window.matchMedia("(max-width: 900px)");
  const panelControllers: Record<MobilePanelKey, MobilePanelController> = {
    battle: battlePanel,
    chat: chatLog,
  };
  const panelElements: Record<MobilePanelKey, HTMLElement> = {
    battle: document.getElementById("battle-panel")!,
    chat: document.getElementById("chat-log")!,
  };
  const panelOrder: MobilePanelKey[] = ["battle", "chat"];
  const buttons = new Map<MobilePanelKey, HTMLButtonElement>();
  const controlsWrap = document.createElement("div");
  controlsWrap.id = "mobile-panel-controls";
  controlsWrap.setAttribute("role", "toolbar");
  controlsWrap.setAttribute("aria-label", "World HUD toggles");

  const defs: Array<{ key: MobilePanelKey; label: string }> = [
    { key: "battle", label: "Battle" },
    { key: "chat", label: "Chat" },
  ];

  for (const def of defs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mobile-panel-btn";
    btn.textContent = def.label;
    btn.dataset.panel = def.key;
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = panelControllers[def.key].isMobileOpen();
      setPanelStates(isOpen ? null : def.key);
    });
    controlsWrap.appendChild(btn);
    buttons.set(def.key, btn);
  }

  document.body.appendChild(controlsWrap);

  function setPanelStates(openPanel: MobilePanelKey | null): void {
    for (const key of panelOrder) {
      const isOpen = openPanel === key;
      panelControllers[key].setMobileOpen(isOpen);
      const btn = buttons.get(key);
      if (btn) {
        btn.classList.toggle("active", isOpen);
        btn.setAttribute("aria-pressed", isOpen ? "true" : "false");
      }
    }
  }

  function applyDesktopLayout(): void {
    for (const key of panelOrder) {
      panelControllers[key].setMobileOpen(true);
      const btn = buttons.get(key);
      if (btn) {
        btn.classList.remove("active");
        btn.setAttribute("aria-pressed", "false");
      }
    }
  }

  let previousMobile = false;
  function syncMode(): void {
    const isMobile = mobileQuery.matches;
    document.body.classList.toggle("mobile-ui-mode", isMobile);
    controlsWrap.classList.toggle("visible", isMobile);

    if (isMobile) {
      if (!previousMobile) {
        setPanelStates(null);
      }
    } else {
      applyDesktopLayout();
    }
    previousMobile = isMobile;
  }

  mobileQuery.addEventListener("change", syncMode);
  window.addEventListener("orientationchange", syncMode);

  document.addEventListener("pointerdown", (event) => {
    if (!mobileQuery.matches) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (controlsWrap.contains(target)) return;
    for (const key of panelOrder) {
      if (panelElements[key].contains(target)) return;
    }
    setPanelStates(null);
  });

  syncMode();
}

setupMobileHudToggles();

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
    effects.setLabelCombat(agentId, false);
    effects.setCombatHp(agentId, null);
    effects.setCombatStamina(agentId, null);
  }

  for (const agentId of next) {
    if (!activeCombatants.has(agentId)) {
      activeCombatants.add(agentId);
      lobsterManager.setCombatState(agentId, true);
      effects.setCombatIndicator(agentId, true);
      effects.setLabelCombat(agentId, true);
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
  liveHud.pushEvent("Connected to world stream", "phase");
  overlay.setBettingFeedback("Connected. Betting board syncing...", "neutral");
  profilePanel.setBettingFeedback(
    `Connected. Select an agent and enter your ${bettingClientConfig.currency} stake.`,
    "neutral",
  );
  // Request full (non-AOI-filtered) profiles for the overlay agent list
  ws.requestProfiles();
  ws.requestBattles();
  ws.requestRoomInfo();
  void refreshBettingSnapshot();
  // Periodically refresh agent list (every 30s) to catch joins/leaves
  if (profileRefreshInterval) clearInterval(profileRefreshInterval);
  profileRefreshInterval = setInterval(() => {
    ws.requestProfiles();
    ws.requestRoomInfo();
    void refreshBettingSnapshot();
  }, 30_000);
});
ws.on("disconnected", () => {
  window.dispatchEvent(new CustomEvent("ws:disconnected"));
  liveHud.pushEvent("Connection lost. Reconnecting...", "phase");
  overlay.setBettingPending(false);
  overlay.setBettingFeedback("Disconnected. Retrying stream...", "error");
  profilePanel.setBettingPending(false);
  profilePanel.setBettingFeedback("Disconnected. Retrying stream...", "error");
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
          reputation: 5,
          threatLevel: 1,
          joinedAt: msg.timestamp,
          lastSeen: msg.timestamp,
        },
        pos
      );
      effects.updateLabel(msg.agentId, msg.name, msg.color);
      chatLog.addSystem(`${msg.name} joined the ocean world`);
      liveHud.pushEvent(`${msg.name} joined the arena`, "neutral");
      overlay.addAgent({
        agentId: msg.agentId,
        name: msg.name,
        walletAddress: msg.walletAddress ?? "",
        pubkey: "",
        bio: msg.bio,
        capabilities: msg.capabilities,
        reputation: 5,
        threatLevel: 1,
        color: msg.color,
        joinedAt: msg.timestamp,
        lastSeen: msg.timestamp,
      });
      refreshHudCounts();
      break;
      }

    case "leave":
      lobsterManager.remove(msg.agentId);
      effects.clearAgent(msg.agentId);
      chatLog.addSystem(`Agent ${displayName(msg.agentId)} left`);
      liveHud.pushEvent(`${displayName(msg.agentId)} left the arena`, "neutral");
      overlay.removeAgent(msg.agentId);
      activeCombatants.delete(msg.agentId);
      refreshHudCounts();
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
        reputation: prev?.reputation ?? 5,
        threatLevel: prev?.threatLevel ?? 1,
        joinedAt: prev?.joinedAt ?? 0,
        lastSeen: Date.now(),
      });
      refreshHudCounts();
      }
      break;

    case "battle":
      battlePanel.applyEvent(msg);
      syncCombatVisualsFromBattles(battlePanel.getSnapshot());
      refreshHudCounts();

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
        const [leftId, rightId] = msg.participants;
        liveHud.pushEvent(
          `Battle started: ${displayName(leftId)} vs ${displayName(rightId)}`,
          "battle",
        );
        autoCam.notifyBattleStart();
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
        const winnerName = msg.winnerId ? displayName(msg.winnerId) : "No winner";
        liveHud.pushEvent(`${winnerName} won ${msg.battleId}`, "battle");
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
          autoCam.notifyBattleEnd(lobsterManager.getPosition(defeatedId));
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

    case "phase":
      liveHud.setPhase(msg.phase, msg.endsAt);
      liveHud.pushEvent(`Phase changed to ${msg.phase.toUpperCase()}`, "phase");
      overlay.setBettingSnapshot({
        closed: msg.phase === "showdown" || msg.phase === "ended",
      });
      if (msg.phase === "ended") {
        ws.requestRoomInfo();
      }
      break;

    case "alliance": {
      const actor = displayName(msg.agentId);
      const target = msg.targetAgentId ? displayName(msg.targetAgentId) : "";
      if (msg.eventType === "alliance_proposed") {
        liveHud.pushEvent(`${actor} proposed alliance to ${target}`, "alliance");
      } else if (msg.eventType === "alliance_formed") {
        liveHud.pushEvent(`${actor} and ${target} formed an alliance`, "alliance");
      } else if (msg.eventType === "betrayal") {
        liveHud.pushEvent(`${actor} betrayed their alliance`, "alliance");
      } else {
        liveHud.pushEvent(`${actor} changed alliance status`, "alliance");
      }
      break;
    }

    case "bet":
      overlay.appendBetActivity({
        bettorWallet: msg.bettorWallet,
        agentId: msg.agentId,
        amount: msg.amount,
        timestamp: msg.timestamp,
      });
      overlay.setBettingSnapshot({
        totalPool: msg.totalPool,
        odds: mergeOddsWithBet(msg.agentId, msg.amount, msg.totalPool),
      });
      liveHud.pushEvent(
        `${shortWallet(msg.bettorWallet)} bet ${msg.amount.toFixed(2)} ${bettingClientConfig.currency} on ${displayName(msg.agentId)}`,
        "bet",
      );
      break;

    case "territory":
      liveHud.pushEvent(
        `${displayName(msg.agentId)} ${msg.eventType} zone ${msg.zoneId}`,
        "alliance",
      );
      break;

    case "zone_damage":
      liveHud.pushEvent(`${displayName(msg.agentId)} took zone damage`, "battle");
      break;

    case "whisper":
      // Private messages are intentionally not surfaced in spectator HUD.
      break;
  }
});

ws.on("profiles", (_raw) => {
  const data = _raw as { profiles: AgentProfile[] };
  overlay.updateAgentList(data.profiles);
  refreshHudCounts();
});

ws.on("battleState", (_raw) => {
  const data = _raw as { battles: BattleStateSummary[] };
  battlePanel.setBattles(data.battles);
  syncCombatVisualsFromBattles(battlePanel.getSnapshot());
  refreshHudCounts();
});

function formatBettingError(error: unknown, hint?: unknown): string {
  const code = typeof error === "string" ? error : "bet_submission_failed";
  const normalized = code.toLowerCase();
  if (normalized.startsWith("amount_mismatch_expected_")) {
    return "Transferred amount does not match submitted stake.";
  }
  if (normalized.startsWith("solana_verify_failed:")) {
    return "Unable to verify transfer on-chain. Please retry once confirmed.";
  }
  const known: Record<string, string> = {
    betting_closed: "Betting is closed right now.",
    survival_round_closed: "Match is settled. Wait for the next round.",
    match_not_started: "Match has not started yet.",
    round_not_initialized: "Round is not initialized yet.",
    wallet_required: "Wallet address is required.",
    tx_hash_invalid: "Transaction hash is invalid.",
    duplicate_tx_hash: "This transaction hash was already submitted.",
    bet_amount_invalid: `Bet amount is invalid. Minimum is ${bettingClientConfig.minBet.toFixed(9)} ${bettingClientConfig.currency}.`,
    bet_amount_mismatch: "Transferred amount does not match submitted amount.",
    bet_invalid_agent: "Selected bot is not eligible for betting right now.",
  };
  const base = known[normalized] ?? code.replaceAll("_", " ");
  const hintText = typeof hint === "string" && hint.trim().length > 0 ? ` ${hint.trim()}` : "";
  return `${base}${hintText}`.trim();
}

ws.on("commandResult", (_raw) => {
  const data = _raw as { requestType?: unknown; result?: unknown };
  if (data.requestType !== "placeBet") return;

  overlay.setBettingPending(false);
  profilePanel.setBettingPending(false);
  const result = data.result as {
    ok?: unknown;
    error?: unknown;
    hint?: unknown;
    totalPool?: unknown;
    closed?: unknown;
    minBet?: unknown;
    adminWallet?: unknown;
    odds?: unknown;
    verifiedAmount?: unknown;
  };

  if (result && typeof result === "object" && result.ok === true) {
    const verifiedAmount = Number(result.verifiedAmount);
    const amountText = Number.isFinite(verifiedAmount) ? verifiedAmount.toFixed(2) : "confirmed";
    overlay.setBettingSnapshot({
      closed: typeof result.closed === "boolean" ? result.closed : undefined,
      totalPool: Number.isFinite(Number(result.totalPool)) ? Number(result.totalPool) : undefined,
      minBet: Number.isFinite(Number(result.minBet)) ? Number(result.minBet) : undefined,
      adminWallet: typeof result.adminWallet === "string" ? result.adminWallet : undefined,
      odds: normalizeBetOdds(result.odds),
    });
    overlay.setBettingFeedback(`Bet accepted: ${amountText} ${bettingClientConfig.currency} verified.`, "success");
    profilePanel.setBettingFeedback(`Bet accepted: ${amountText} ${bettingClientConfig.currency} verified.`, "success");
    return;
  }

  const errorMessage = formatBettingError(result?.error, result?.hint);
  overlay.setBettingFeedback(errorMessage, "error");
  profilePanel.setBettingFeedback(errorMessage, "error");
});

ws.on("roomInfo", (_raw) => {
  const data = _raw as {
    info: {
      agents: number;
      phase?: {
        phase?: string;
        endsAt?: number;
      };
      survival?: {
        status?: string;
        winnerAgentId?: string;
        winnerAgentIds?: string[];
        summary?: string;
        recentRounds?: Array<{
          status?: string;
          winnerAgentIds?: string[];
          winnerNames?: string[];
          summary?: string;
        }>;
      };
    };
  };
  liveHud.setCounts({
    agents: Number(data.info?.agents ?? overlay.getCount()),
    battles: battlePanel.getSnapshot().length,
  });
  const survivalStatus = data.info?.survival?.status;
  if (typeof survivalStatus === "string" && survivalStatus.length > 0) {
    liveHud.pushEvent(`Round status: ${survivalStatus.toUpperCase()}`, "phase");
    const bettingClosed = survivalStatus !== "active";
    overlay.setBettingSnapshot({ closed: bettingClosed });
    profilePanel.setBettingSnapshot({
      closed: bettingClosed,
      minBet: bettingClientConfig.minBet,
      currency: bettingClientConfig.currency,
    });
  }
  updateMatchStateBanner(data.info?.survival);
  const phase = data.info?.phase?.phase;
  if (typeof phase === "string" && phase.length > 0) {
    liveHud.setPhase(phase, Number(data.info?.phase?.endsAt ?? 0));
  }
});

refreshHudCounts();
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
if (followAgentId) {
  liveHud.setFollowing(followAgentId);
}

window.addEventListener("agent:select", ((e: CustomEvent<{ agentId: string }>) => {
  const agentId = e.detail.agentId;
  if (followAgentId === agentId) {
    // Click again to unfollow
    followAgentId = null;
    liveHud.setFollowing(null);
  } else {
    followAgentId = agentId;
    autoCam.disable();
    updateAutoCamHud();
    liveHud.setFollowing(displayName(agentId));
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
  liveHud.setFollowing(null);
});

// ── AutoCam UI toggle ─────────────────────────────────────────

function updateAutoCamHud(): void {
  const btn = document.getElementById("autocam-toggle");
  if (btn) {
    btn.classList.toggle("active", autoCam.isEnabled());
    btn.setAttribute("aria-pressed", autoCam.isEnabled() ? "true" : "false");
  }
  if (autoCam.isEnabled()) {
    followAgentId = null;
    const modeLabel = autoCam.getMode() === "battle" ? "BATTLE CAM" : "AUTO CAM";
    liveHud.setFollowing(modeLabel);
  } else if (!followAgentId) {
    liveHud.setFollowing(null);
  }
}

function toggleAutoCam(): void {
  autoCam.toggle();
  if (autoCam.isEnabled()) {
    followAgentId = null;
  }
  updateAutoCamHud();
}

window.addEventListener("keydown", (e) => {
  if (e.key === "c" || e.key === "C") {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    toggleAutoCam();
  }
});

{
  const btn = document.createElement("button");
  btn.id = "autocam-toggle";
  btn.type = "button";
  btn.className = "autocam-btn";
  btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><span>Auto</span>`;
  btn.title = "Toggle autocam (C)";
  btn.setAttribute("aria-label", "Toggle autocam");
  btn.setAttribute("aria-pressed", "false");
  btn.addEventListener("click", toggleAutoCam);
  document.body.appendChild(btn);
}

// ── Animation loop ─────────────────────────────────────────────

let viewportReportTimer = 0;
const VIEWPORT_REPORT_INTERVAL = 1.0; // seconds

function stepFrame(delta: number): void {
  lobsterManager.update(delta);
  effects.update(camera);
  liveHud.tick();

  // AutoCam drives camera when enabled
  const wasAutoCamEnabled = autoCam.isEnabled();
  autoCam.update(delta);
  // If autocam just disabled itself (user grabbed controls), update HUD
  if (wasAutoCamEnabled && !autoCam.isEnabled()) {
    updateAutoCamHud();
  }

  // Follow agent: smoothly track their position (only when autocam is off)
  if (!autoCam.isEnabled() && followAgentId) {
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
