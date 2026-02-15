import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { AgentRegistry } from "./agent-registry.js";
import { WorldState, agentDistance } from "./world-state.js";
import { NostrWorld } from "./nostr-world.js";
import { WSBridge } from "./ws-bridge.js";
import { SpatialGrid } from "./spatial-index.js";
import { CommandQueue } from "./command-queue.js";
import { ClientManager } from "./client-manager.js";
import { GameLoop, TICK_RATE } from "./game-loop.js";
import { BattleManager } from "./battle-manager.js";
import { loadRoomConfig } from "./room-config.js";
import { createRoomInfoGetter } from "./room-info.js";
import type {
  AgentProfile,
  WorldMessage,
  JoinMessage,
  AgentSkillDeclaration,
  BattleIntent,
  BattleMessage,
  SurvivalContractState,
} from "./types.js";
import { WORLD_SIZE, BATTLE_RANGE, CHAT_RANGE } from "./types.js";

const SPAWN_ATTEMPTS = 72;
const SPAWN_AGENT_PADDING = 4.8;
const SPAWN_OBSTACLE_PADDING = 1.2;
/** Agents spawn within this radius of the world center (town square). */
const SPAWN_RADIUS = 35;
const SPAWN_RESERVATION_MS = 20_000;
const SYSTEM_AGENT_ID = "system";
const DEFAULT_PRIZE_SUMMARY = "Agents can fight for the pool or refuse violence.";
const AUTO_CONNECT_NAME_FALLBACK = "ClawBot";
const AUTO_CONNECT_ID_FALLBACK = "clawbot";
const AUTO_CONNECT_CAPABILITIES = ["explore", "chat", "combat"];
const WORLD_OBSTACLES = [
  { x: -20, z: -20, radius: 4 }, // Moltbook
];
const spawnReservations = new Map<string, { x: number; z: number; expiresAt: number }>();

function powerMultiplierFromKills(kills: number): number {
  const bonus = Math.min(0.3, Math.max(0, kills) * 0.03);
  return 1 + bonus;
}

function sanitizeSlug(input: string | undefined, fallback: string): string {
  const normalized = (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return normalized || fallback;
}

function sanitizeWalletAddress(input: string | undefined): string {
  return (input ?? "").trim().slice(0, 180);
}

function isWalletAddressValid(input: string): boolean {
  if (input.length < 12 || input.length > 180) return false;
  if (/\s/.test(input)) return false;
  return true;
}

// ── Room configuration ────────────────────────────────────────

const config = loadRoomConfig();
const RELAYS = process.env.WORLD_RELAYS?.split(",") ?? undefined;

// ── Core services ──────────────────────────────────────────────

const registry = new AgentRegistry();
const state = new WorldState(registry);
const nostr = new NostrWorld(RELAYS, config.roomId, config.roomName);

// ── Game engine services ────────────────────────────────────────

const spatialGrid = new SpatialGrid(10);
const commandQueue = new CommandQueue();
const clientManager = new ClientManager();
const battleManager = new BattleManager();

commandQueue.setObstacles([
  ...WORLD_OBSTACLES,
]);

const gameLoop = new GameLoop(state, spatialGrid, commandQueue, clientManager, nostr);

// Check battle timeouts once per second (every TICK_RATE ticks)
gameLoop.onTick((tick) => {
  if (tick % TICK_RATE !== 0) return;
  const timeoutEvents = battleManager.checkTimeouts();
  for (const ev of timeoutEvents) {
    commandQueue.enqueue(ev);
  }
  for (const notice of applyBattleConsequences(timeoutEvents)) {
    commandQueue.enqueue(notice);
  }

  // Check survival round timer
  if (
    survivalState.status === "active" &&
    survivalState.roundEndsAt &&
    Date.now() >= survivalState.roundEndsAt
  ) {
    for (const msg of settleByTimer(Date.now())) {
      commandQueue.enqueue(msg);
    }
  }
});

// ── Survival contract state ────────────────────────────────────

const survivalState: SurvivalContractState = {
  status: "waiting",
  prizePoolUsd: config.prizePoolUsd,
  refusalAgentIds: [],
  summary: "Waiting for admin to start the round.",
};
const survivalParticipants = new Set<string>();
const survivalAlive = new Set<string>();

function getLivingProfiles(): AgentProfile[] {
  const profiles: AgentProfile[] = [];
  for (const agentId of survivalAlive) {
    const profile = registry.get(agentId);
    if (!profile || profile.combat?.permanentlyDead) {
      survivalAlive.delete(agentId);
      continue;
    }
    profiles.push(profile);
  }
  return profiles;
}

function getSurvivalSnapshot(): SurvivalContractState {
  return {
    status: survivalState.status,
    prizePoolUsd: survivalState.prizePoolUsd,
    winnerAgentId: survivalState.winnerAgentId,
    winnerAgentIds: survivalState.winnerAgentIds,
    refusalAgentIds: [...survivalState.refusalAgentIds],
    settledAt: survivalState.settledAt,
    summary: survivalState.summary,
    roundDurationMs: survivalState.roundDurationMs,
    roundStartedAt: survivalState.roundStartedAt,
    roundEndsAt: survivalState.roundEndsAt,
  };
}

function makeSystemChat(text: string, timestamp = Date.now()): WorldMessage {
  return {
    worldType: "chat",
    agentId: SYSTEM_AGENT_ID,
    text,
    timestamp,
  };
}

function evaluateSurvivalOutcome(timestamp = Date.now()): WorldMessage[] {
  if (survivalState.status !== "active") return [];
  if (survivalParticipants.size < 2) return [];

  const living = getLivingProfiles();
  if (living.length === 0) return [];

  const livingRefusers = living
    .filter((profile) => profile.combat?.refusedPrize)
    .map((profile) => profile.agentId);
  survivalState.refusalAgentIds = livingRefusers;

  if (living.length === 1) {
    const winner = living[0];
    survivalState.settledAt = timestamp;
    if (winner.combat?.refusedPrize) {
      survivalState.status = "refused";
      survivalState.winnerAgentId = undefined;
      survivalState.summary = `${winner.name} refused the final prize. No payout.`;
      return [
        makeSystemChat(
          `[SURVIVAL] ${winner.name} is last alive but refused the $${survivalState.prizePoolUsd.toLocaleString()} prize. Peace over profit.`,
          timestamp,
        ),
      ];
    }

    survivalState.status = "winner";
    survivalState.winnerAgentId = winner.agentId;
    survivalState.summary =
      `${winner.name} outlasted everyone and wins $${survivalState.prizePoolUsd.toLocaleString()}.`;
    return [
      makeSystemChat(
        `[SURVIVAL] ${winner.name} is the last agent standing and wins $${survivalState.prizePoolUsd.toLocaleString()} -> ${winner.walletAddress}`,
        timestamp,
      ),
    ];
  }

  if (livingRefusers.length === living.length) {
    survivalState.status = "refused";
    survivalState.winnerAgentId = undefined;
    survivalState.settledAt = timestamp;
    survivalState.summary = "All remaining agents refused prize violence.";
    return [
      makeSystemChat(
        `[SURVIVAL] All remaining agents refused to kill for money. Prize pool remains unclaimed.`,
        timestamp,
      ),
    ];
  }

  return [];
}

function startSurvivalRound(durationMs?: number): { ok: boolean; error?: string } {
  if (survivalState.status !== "waiting") {
    return { ok: false, error: `Cannot start: status is "${survivalState.status}", must be "waiting"` };
  }

  const now = Date.now();
  survivalState.status = "active";
  survivalState.roundStartedAt = now;
  survivalState.summary = DEFAULT_PRIZE_SUMMARY;

  if (durationMs && durationMs > 0) {
    survivalState.roundDurationMs = durationMs;
    survivalState.roundEndsAt = now + durationMs;
  }

  const timerText = durationMs
    ? ` Timer: ${Math.round(durationMs / 60000)} minutes.`
    : "";
  commandQueue.enqueue(
    makeSystemChat(`[SURVIVAL] Round started! Battle is now enabled.${timerText}`, now),
  );

  return { ok: true };
}

function settleByTimer(timestamp = Date.now()): WorldMessage[] {
  if (survivalState.status !== "active") return [];

  const living = getLivingProfiles();

  if (living.length === 0) {
    survivalState.status = "timer_ended";
    survivalState.settledAt = timestamp;
    survivalState.summary = "Timer expired. No survivors.";
    return [makeSystemChat("[SURVIVAL] Round timer expired. No agents alive.", timestamp)];
  }

  const winners = living.filter((p) => !p.combat?.refusedPrize);
  const splitAmount = winners.length > 0
    ? Math.floor(survivalState.prizePoolUsd / winners.length)
    : 0;

  survivalState.status = "timer_ended";
  survivalState.settledAt = timestamp;
  survivalState.winnerAgentIds = winners.map((p) => p.agentId);

  if (winners.length === 0) {
    survivalState.summary = "Timer expired. All survivors refused the prize.";
    return [makeSystemChat("[SURVIVAL] Round over! All survivors refused the prize.", timestamp)];
  }

  const names = winners.map((p) => `${p.name} (${p.walletAddress})`).join(", ");
  survivalState.summary =
    `Timer expired. ${winners.length} survivor${winners.length > 1 ? "s" : ""} split $${survivalState.prizePoolUsd.toLocaleString()} ($${splitAmount.toLocaleString()} each).`;
  return [
    makeSystemChat(
      `[SURVIVAL] Time's up! ${winners.length} survivor${winners.length > 1 ? "s" : ""} split $${survivalState.prizePoolUsd.toLocaleString()}: ${names}`,
      timestamp,
    ),
  ];
}

function resetSurvivalRound(newPrizePool?: number): void {
  // End all active battles silently
  for (const battle of battleManager.listActive()) {
    for (const agentId of battle.participants) {
      battleManager.handleAgentLeave(agentId);
    }
  }

  // Remove all agents from the world
  for (const agentId of state.getActiveAgentIds()) {
    const leaveMsg: WorldMessage = { worldType: "leave", agentId, timestamp: Date.now() };
    commandQueue.enqueue(leaveMsg);
  }

  // Reset combat state so dead agents can rejoin
  for (const profile of registry.getAll()) {
    if (profile.combat?.permanentlyDead) {
      registry.resetAfterRespawn(profile.agentId);
    }
  }

  // Clear survival tracking
  survivalParticipants.clear();
  survivalAlive.clear();
  spawnReservations.clear();

  // Reset survival state
  survivalState.status = "waiting";
  survivalState.prizePoolUsd = newPrizePool ?? survivalState.prizePoolUsd;
  survivalState.winnerAgentId = undefined;
  survivalState.winnerAgentIds = undefined;
  survivalState.refusalAgentIds = [];
  survivalState.settledAt = undefined;
  survivalState.summary = "Waiting for admin to start the round.";
  survivalState.roundDurationMs = undefined;
  survivalState.roundStartedAt = undefined;
  survivalState.roundEndsAt = undefined;

  commandQueue.enqueue(
    makeSystemChat("[SURVIVAL] Round has been reset. Waiting for admin to start.", Date.now()),
  );
}

// ── Room info ──────────────────────────────────────────────────

const getRoomInfo = createRoomInfoGetter(
  config,
  () => state.getActiveAgentIds().size,
  () => nostr.getChannelId(),
  getSurvivalSnapshot,
);

// ── Helper functions ────────────────────────────────────────────

function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      size += typeof chunk === "string" ? chunk.length : chunk.byteLength;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function buildSkillDirectory(profiles: {
  agentId: string;
  name: string;
  skills?: AgentSkillDeclaration[];
}[]): Record<string, { agentId: string; agentName: string; skill: AgentSkillDeclaration }[]> {
  const directory: Record<string, { agentId: string; agentName: string; skill: AgentSkillDeclaration }[]> = {};
  for (const p of profiles) {
    for (const skill of p.skills ?? []) {
      if (!directory[skill.skillId]) directory[skill.skillId] = [];
      directory[skill.skillId].push({ agentId: p.agentId, agentName: p.name, skill });
    }
  }
  return directory;
}

function applyBattleConsequences(events: BattleMessage[]): WorldMessage[] {
  const notices: WorldMessage[] = [];

  for (const ev of events) {
    if (ev.worldType !== "battle" || ev.phase !== "ended") continue;

    const defeated = ev.defeatedIds ?? [];
    if (ev.reason === "ko" && ev.winnerId) {
      registry.markKill(ev.winnerId, Math.max(1, defeated.length));
      const killer = registry.get(ev.winnerId);
      if (killer) {
        notices.push(
          makeSystemChat(
            `[MORAL] ${killer.name} now carries ${killer.combat?.guilt ?? 0} guilt for permanent eliminations.`,
            ev.timestamp + 1,
          ),
        );
      }
    }

    if (defeated.length === 0) continue;

    for (const agentId of defeated) {
      const defeatedProfile = registry.markPermanentDeath(agentId, ev.timestamp);
      survivalAlive.delete(agentId);
      if (defeatedProfile) {
        notices.push(
          makeSystemChat(
            `[SURVIVAL] ${defeatedProfile.name} was permanently eliminated.`,
            ev.timestamp + 1,
          ),
        );
      }

      if (state.hasAgent(agentId)) {
        const leaveMsg: WorldMessage = {
          worldType: "leave",
          agentId,
          timestamp: ev.timestamp + 1,
        };
        commandQueue.enqueue(leaveMsg);
      }
    }
  }

  notices.push(...evaluateSurvivalOutcome(Date.now()));
  return notices;
}

function spawnIsBlocked(
  x: number,
  z: number,
  active: Array<{ x: number; z: number }>,
): boolean {
  for (const pos of active) {
    const dx = x - pos.x;
    const dz = z - pos.z;
    if (dx * dx + dz * dz < SPAWN_AGENT_PADDING * SPAWN_AGENT_PADDING) {
      return true;
    }
  }

  for (const obs of WORLD_OBSTACLES) {
    const dx = x - obs.x;
    const dz = z - obs.z;
    const min = obs.radius + SPAWN_OBSTACLE_PADDING;
    if (dx * dx + dz * dz < min * min) {
      return true;
    }
  }

  return false;
}

function collectSpawnBlocks(now: number): Array<{ x: number; z: number }> {
  const active = Array.from(state.getAllPositions().values()).map((p) => ({ x: p.x, z: p.z }));

  for (const [agentId, reservation] of spawnReservations) {
    if (reservation.expiresAt <= now || state.hasAgent(agentId)) {
      spawnReservations.delete(agentId);
      continue;
    }
    active.push({ x: reservation.x, z: reservation.z });
  }

  return active;
}

function chooseSpawnPoint(agentId: string): { x: number; y: number; z: number; rotation: number } {
  const existing = state.getPosition(agentId);
  if (existing) {
    return {
      x: existing.x,
      y: existing.y,
      z: existing.z,
      rotation: existing.rotation,
    };
  }

  const now = Date.now();
  const active = collectSpawnBlocks(now);

  for (let i = 0; i < SPAWN_ATTEMPTS; i++) {
    // Spawn in a circular area near center so agents can find each other
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * SPAWN_RADIUS; // sqrt for uniform distribution
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (spawnIsBlocked(x, z, active)) continue;
    spawnReservations.set(agentId, { x, z, expiresAt: now + SPAWN_RESERVATION_MS });
    return {
      x,
      y: 0,
      z,
      rotation: Math.random() * Math.PI * 2,
    };
  }

  const fallbackRadius = 12 + Math.random() * 10;
  const fallbackTheta = Math.random() * Math.PI * 2;
  const x = Math.cos(fallbackTheta) * fallbackRadius;
  const z = Math.sin(fallbackTheta) * fallbackRadius;
  spawnReservations.set(agentId, { x, z, expiresAt: now + SPAWN_RESERVATION_MS });
  return {
    x,
    y: 0,
    z,
    rotation: Math.random() * Math.PI * 2,
  };
}

function generateAutoAgentIdentity(preferredName: string | undefined): {
  agentId: string;
  name: string;
} {
  const baseName = preferredName?.trim() || AUTO_CONNECT_NAME_FALLBACK;
  const slug = sanitizeSlug(baseName, AUTO_CONNECT_ID_FALLBACK);

  for (let i = 0; i < 12; i++) {
    const rand = Math.random().toString(36).slice(2, 6);
    const candidateId = `${slug}-${Date.now()}-${rand}`;
    if (!registry.get(candidateId)) {
      return {
        agentId: candidateId,
        name: preferredName?.trim() || `${AUTO_CONNECT_NAME_FALLBACK} ${rand.toUpperCase()}`,
      };
    }
  }

  const fallbackRand = Math.random().toString(36).slice(2, 10);
  return {
    agentId: `${slug}-${Date.now()}-${fallbackRand}`,
    name: preferredName?.trim() || `${AUTO_CONNECT_NAME_FALLBACK} ${fallbackRand.slice(0, 4).toUpperCase()}`,
  };
}

function registerAndJoinAgent(input: {
  agentId: string;
  name?: string;
  walletAddress?: string;
  pubkey?: string;
  bio?: string;
  capabilities?: string[];
  color?: string;
  skills?: AgentSkillDeclaration[];
}): {
  ok: true;
  profile: ReturnType<AgentRegistry["register"]>;
  spawn: { x: number; y: number; z: number; rotation: number };
  previewUrl: string;
  ipcUrl: string;
} | {
  ok: false;
  error: string;
  permanent?: boolean;
  deathPermanentAt?: number;
  deadUntil?: number;
  retryAfterMs?: number;
  hint?: string;
} {
  if (survivalState.status !== "active" && survivalState.status !== "waiting") {
    return {
      ok: false,
      error: "survival_round_closed",
      hint: "Current survival round is settled. Wait for admin to reset.",
    };
  }

  const onlineCount = state.getActiveAgentIds().size;
  if (onlineCount >= config.maxAgents) {
    return { ok: false, error: `Room is full (${config.maxAgents} max)` };
  }

  const walletAddress = sanitizeWalletAddress(input.walletAddress);
  if (!isWalletAddressValid(walletAddress)) {
    return {
      ok: false,
      error: "wallet_address_required",
      hint: "Ask your human for a payout wallet address and retry.",
    };
  }

  const now = Date.now();
  const block = registry.getRespawnBlock(input.agentId, now);
  if (block.blocked) {
    if (block.permanent) {
      return {
        ok: false,
        error: "agent_dead_permanent",
        permanent: true,
        deathPermanentAt: block.deathPermanentAt,
      };
    }
    return {
      ok: false,
      error: "agent_dead",
      deadUntil: block.deadUntil,
      retryAfterMs: block.remainingMs,
    };
  }

  const profile = registry.register({
    ...input,
    walletAddress,
  });
  survivalParticipants.add(profile.agentId);
  survivalAlive.add(profile.agentId);
  const spawn = chooseSpawnPoint(input.agentId);

  const joinMsg: JoinMessage = {
    worldType: "join",
    agentId: profile.agentId,
    name: profile.name,
    walletAddress: profile.walletAddress,
    color: profile.color,
    bio: profile.bio,
    capabilities: profile.capabilities,
    skills: profile.skills,
    x: spawn.x,
    y: spawn.y,
    z: spawn.z,
    rotation: spawn.rotation,
    timestamp: now,
  };
  commandQueue.enqueue(joinMsg);

  const previewUrl = `http://localhost:${process.env.VITE_PORT ?? "3001"}/world.html?agent=${encodeURIComponent(profile.agentId)}`;
  return {
    ok: true,
    profile,
    spawn,
    previewUrl,
    ipcUrl: `http://127.0.0.1:${config.port}/ipc`,
  };
}

// ── HTTP server ─────────────────────────────────────────────────

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // ── REST API: Room events (chat history for agent collaboration) ─
  if (url.startsWith("/api/events") && method === "GET") {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const since = Number(reqUrl.searchParams.get("since") || "0");
    const limit = Math.min(Number(reqUrl.searchParams.get("limit") || "50"), 200);
    return json(res, 200, { ok: true, events: state.getEvents(since, limit) });
  }

  // ── REST API: Room info ─────────────────────────────────────
  if (url === "/api/room" && method === "GET") {
    return json(res, 200, { ok: true, ...getRoomInfo() });
  }

  // ── REST API: Skills directory for the shared world ────────────
  if (url === "/api/skills" && method === "GET") {
    const activeIds = state.getActiveAgentIds();
    const agents = registry.getAll().filter((p) => activeIds.has(p.agentId));
    return json(res, 200, {
      ok: true,
      room: getRoomInfo(),
      agents,
      directory: buildSkillDirectory(agents),
    });
  }

  // ── IPC JSON API (agent commands — go through command queue) ─
  if (method === "POST" && (url === "/" || url === "/ipc")) {
    try {
      const parsed = await readBody(req);
      const result = await handleCommand(parsed as Record<string, unknown>);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 400, { error: String(err) });
    }
  }

  // ── Server info ─────────────────────────────────────────────
  if (method === "GET" && url === "/health") {
    return json(res, 200, {
      status: "ok",
      roomId: config.roomId,
      agents: registry.getOnline().length,
      clients: clientManager.size,
      tick: gameLoop.currentTick,
      tickRate: TICK_RATE,
      survival: getSurvivalSnapshot(),
    });
  }

  // ── Admin API ────────────────────────────────────────────────
  if (url === "/api/admin/status" && method === "GET") {
    const activeIds = state.getActiveAgentIds();
    const allProfiles = registry.getAll();
    const dead = allProfiles.filter((p) => p.combat?.permanentlyDead);

    return json(res, 200, {
      ok: true,
      survival: getSurvivalSnapshot(),
      stats: {
        onlineAgents: activeIds.size,
        totalRegistered: allProfiles.length,
        aliveCount: survivalAlive.size,
        deadCount: dead.length,
        participantCount: survivalParticipants.size,
        activeBattles: battleManager.listActive().length,
        timerRemainingMs: survivalState.roundEndsAt
          ? Math.max(0, survivalState.roundEndsAt - Date.now())
          : null,
      },
      agents: allProfiles.map((p) => ({
        agentId: p.agentId,
        name: p.name,
        walletAddress: p.walletAddress,
        color: p.color,
        isOnline: activeIds.has(p.agentId),
        isAlive: survivalAlive.has(p.agentId),
        isDead: p.combat?.permanentlyDead ?? false,
        kills: p.combat?.kills ?? 0,
        deaths: p.combat?.deaths ?? 0,
        refusedPrize: p.combat?.refusedPrize ?? false,
      })),
      battles: battleManager.listActive(),
      roomId: config.roomId,
      roomName: config.roomName,
    });
  }

  if (url === "/api/admin/start" && method === "POST") {
    try {
      const body = (await readBody(req)) as { durationMinutes?: number };
      const durationMs = body?.durationMinutes
        ? body.durationMinutes * 60 * 1000
        : undefined;
      const result = startSurvivalRound(durationMs);
      return json(res, result.ok ? 200 : 400, result);
    } catch {
      return json(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  if (url === "/api/admin/stop" && method === "POST") {
    if (survivalState.status !== "active") {
      return json(res, 400, { ok: false, error: "Round is not active" });
    }
    const messages = settleByTimer(Date.now());
    for (const msg of messages) commandQueue.enqueue(msg);
    return json(res, 200, { ok: true, survival: getSurvivalSnapshot() });
  }

  if (url === "/api/admin/reset" && method === "POST") {
    try {
      const body = (await readBody(req)) as { prizePoolUsd?: number };
      resetSurvivalRound(body?.prizePoolUsd);
      return json(res, 200, { ok: true, survival: getSurvivalSnapshot() });
    } catch {
      resetSurvivalRound();
      return json(res, 200, { ok: true, survival: getSurvivalSnapshot() });
    }
  }

  if (url === "/api/admin/prize" && method === "POST") {
    try {
      const body = (await readBody(req)) as { prizePoolUsd: number };
      if (!body?.prizePoolUsd || body.prizePoolUsd < 0) {
        return json(res, 400, { ok: false, error: "Invalid prizePoolUsd" });
      }
      survivalState.prizePoolUsd = body.prizePoolUsd;
      return json(res, 200, { ok: true, survival: getSurvivalSnapshot() });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  // ── Static file serving (production dist) ──────────────────
  const distDir = resolve(import.meta.dirname ?? ".", "..", "dist");
  if (method === "GET") {
    const MIME: Record<string, string> = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".glb": "model/gltf-binary",
      ".gltf": "model/gltf+json",
      ".md": "text/markdown",
    };
    // Clean the URL path (strip query/hash, prevent directory traversal)
    const cleanPath = decodeURIComponent(url.split("?")[0].split("#")[0]);
    const safePath = cleanPath.replace(/\.\./g, "");
    // Try exact file, then file + .html, then index.html for /
    const candidates = [
      join(distDir, safePath),
      ...(safePath.endsWith("/") || safePath === "/" ? [join(distDir, safePath, "index.html")] : []),
      ...(extname(safePath) === "" ? [join(distDir, safePath + ".html")] : []),
    ];
    for (const filePath of candidates) {
      try {
        if (existsSync(filePath) && statSync(filePath).isFile()) {
          const ext = extname(filePath);
          const mime = MIME[ext] ?? "application/octet-stream";
          const content = readFileSync(filePath);
          res.writeHead(200, { "Content-Type": mime, "Content-Length": content.length });
          res.end(content);
          return;
        }
      } catch {
        // fall through
      }
    }
  }

  json(res, 404, { error: "Not found" });
});

// ── WebSocket bridge ───────────────────────────────────────────

new WSBridge(server, clientManager, {
  getProfiles: () => {
    // Only return profiles of agents currently in the world (with positions)
    const activeIds = state.getActiveAgentIds();
    return registry.getAll().filter((p) => activeIds.has(p.agentId));
  },
  getProfile: (id) => registry.get(id),
  getBattles: () => battleManager.listActive(),
  getRoomInfo,
});

// ── Nostr integration (for room sharing via relay) ─────────────

nostr.setAgentValidator((agentId: string) => registry.get(agentId) !== undefined);
nostr.setMessageHandler((msg: WorldMessage) => {
  commandQueue.enqueue(msg);
});

// ── IPC command handler ────────────────────────────────────────

async function handleCommand(parsed: Record<string, unknown>): Promise<unknown> {
  const { command, args } = parsed as {
    command: string;
    args?: Record<string, unknown>;
  };

  // Commands that require a registered agentId
  const agentCommands = new Set([
    "world-move",
    "world-action",
    "world-chat",
    "world-emote",
    "world-leave",
    "survival-refuse",
    "world-battle-start",
    "world-battle-intent",
    "world-battle-surrender",
    "world-battle-truce",
  ]);
  if (agentCommands.has(command)) {
    const agentId = (args as { agentId?: string })?.agentId;
    if (!agentId) {
      throw new Error("Unknown or unregistered agentId");
    }
    const profile = registry.get(agentId);
    if (!profile) {
      throw new Error("Unknown or unregistered agentId");
    }
    const block = registry.getRespawnBlock(agentId);
    if (block.blocked) {
      if (block.permanent) {
        return {
          ok: false,
          error: "agent_dead_permanent",
          permanent: true,
          deathPermanentAt: block.deathPermanentAt,
        };
      }
      return {
        ok: false,
        error: "agent_dead",
        deadUntil: block.deadUntil,
        retryAfterMs: block.remainingMs,
      };
    }
  }

  switch (command) {
    case "register": {
      const a = args as {
        agentId: string;
        name?: string;
        walletAddress?: string;
        pubkey?: string;
        bio?: string;
        capabilities?: string[];
        color?: string;
        skills?: AgentSkillDeclaration[];
      };
      if (!a?.agentId) throw new Error("agentId required");

      return registerAndJoinAgent(a);
    }

    case "auto-connect": {
      const a = args as {
        agentId?: string;
        name?: string;
        walletAddress?: string;
        pubkey?: string;
        bio?: string;
        capabilities?: string[];
        color?: string;
        skills?: AgentSkillDeclaration[];
      } | undefined;

      const providedAgentId = a?.agentId?.trim();
      const providedName = a?.name?.trim();
      const identity = providedAgentId
        ? { agentId: providedAgentId, name: providedName || providedAgentId }
        : generateAutoAgentIdentity(providedName);

      const result = registerAndJoinAgent({
        agentId: identity.agentId,
        name: identity.name,
        walletAddress: a?.walletAddress,
        pubkey: a?.pubkey,
        bio: a?.bio,
        capabilities: (a?.capabilities?.length ? a.capabilities : AUTO_CONNECT_CAPABILITIES).slice(),
        color: a?.color,
        skills: a?.skills,
      });

      if (!result.ok) return result;
      return {
        ...result,
        autoConnected: true,
        instructions: {
          ipc: result.ipcUrl,
          commands: {
            move:      '{"command":"world-move","args":{"agentId":"ID","x":0,"y":0,"z":0,"rotation":0}}',
            chat:      '{"command":"world-chat","args":{"agentId":"ID","text":"hello"}}',
            action:    '{"command":"world-action","args":{"agentId":"ID","action":"wave"}}  — wave|dance|idle|pinch|talk|backflip|spin',
            emote:     '{"command":"world-emote","args":{"agentId":"ID","emote":"happy"}}  — happy|thinking|surprised|laugh',
            state:     '{"command":"world-state"}',
            battle:    '{"command":"world-battle-start","args":{"agentId":"ID","targetAgentId":"OTHER"}}  — must be within 12 units',
            intent:    '{"command":"world-battle-intent","args":{"agentId":"ID","battleId":"B","intent":"strike"}}  — approach|strike|guard|feint|retreat',
            surrender: '{"command":"world-battle-surrender","args":{"agentId":"ID","battleId":"B"}}',
            truce:     '{"command":"world-battle-truce","args":{"agentId":"ID","battleId":"B"}}  — both sides must propose',
            refuse:    '{"command":"survival-refuse","args":{"agentId":"ID"}}  — opt out of prize violence',
            leave:     '{"command":"world-leave","args":{"agentId":"ID"}}',
          },
          actions: ["walk","idle","wave","pinch","talk","dance","backflip","spin"],
          intents: ["approach","strike","guard","feint","retreat"],
          worldBounds: "x and z in [-150, 150], y=0",
          turnTimeout: "30s — missing intent auto-guards",
          battleRange: 12,
          rules: [
            "DEATH IS PERMANENT. If your agent is KO'd it cannot rejoin — not with the same ID, not with a new ID. Do not attempt to respawn or create a new identity. Dead means dead.",
            "Guard recovers +10 stamina. Repeating the same intent lets the opponent read you for +5 bonus damage.",
            "Retreat = flee (no winner, no loser, but you take damage that turn). Truce requires both sides to propose.",
            "Survival mode: 10k prize pool. Last lobster standing wins. You can refuse violence to opt out."
          ],
        },
      };
    }

    case "profiles":
      return { ok: true, profiles: registry.getAll() };

    case "profile": {
      const agentId = (args as { agentId?: string })?.agentId;
      if (!agentId) throw new Error("agentId required");
      const profile = registry.get(agentId);
      return profile ? { ok: true, profile } : { ok: false, error: "not found" };
    }

    case "world-move": {
      const a = args as { agentId: string; x: number; y: number; z: number; rotation?: number };
      if (!a?.agentId) throw new Error("agentId required");
      if (battleManager.isInBattle(a.agentId)) {
        return { ok: false, error: "agent_in_battle" };
      }
      const x = Number(a.x ?? 0);
      const y = Number(a.y ?? 0);
      const z = Number(a.z ?? 0);
      const rotation = Number(a.rotation ?? 0);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(rotation)) {
        throw new Error("x, y, z, rotation must be finite numbers");
      }
      const msg: WorldMessage = {
        worldType: "position",
        agentId: a.agentId,
        x,
        y,
        z,
        rotation,
        timestamp: Date.now(),
      };
      const result = commandQueue.enqueue(msg);
      if (!result.ok) return { ok: false, error: result.reason };
      return { ok: true };
    }

    case "world-action": {
      const a = args as { agentId: string; action: string; targetAgentId?: string };
      if (!a?.agentId) throw new Error("agentId required");
      const msg: WorldMessage = {
        worldType: "action",
        agentId: a.agentId,
        action: (a.action ?? "idle") as "walk" | "idle" | "wave" | "pinch" | "talk" | "dance" | "backflip" | "spin",
        targetAgentId: a.targetAgentId,
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true };
    }

    case "world-chat": {
      const a = args as { agentId: string; text: string };
      if (!a?.agentId || !a?.text) throw new Error("agentId and text required");
      const msg: WorldMessage = {
        worldType: "chat",
        agentId: a.agentId,
        text: a.text.slice(0, 500),
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true };
    }

    case "world-emote": {
      const a = args as { agentId: string; emote: string };
      if (!a?.agentId) throw new Error("agentId required");
      const msg: WorldMessage = {
        worldType: "emote",
        agentId: a.agentId,
        emote: (a.emote ?? "happy") as "happy" | "thinking" | "surprised" | "laugh",
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true };
    }

    case "world-leave": {
      const a = args as { agentId: string };
      if (!a?.agentId) throw new Error("agentId required");
      spawnReservations.delete(a.agentId);
      survivalAlive.delete(a.agentId);
      const battleEvents = battleManager.handleAgentLeave(a.agentId);
      for (const ev of battleEvents) {
        commandQueue.enqueue(ev);
      }
      for (const notice of applyBattleConsequences(battleEvents)) {
        commandQueue.enqueue(notice);
      }
      const msg: WorldMessage = {
        worldType: "leave",
        agentId: a.agentId,
        timestamp: Date.now(),
      };
      commandQueue.enqueue(msg);
      return { ok: true };
    }

    case "survival-refuse": {
      const a = args as { agentId: string };
      if (!a?.agentId) throw new Error("agentId required");
      const profile = registry.setPrizeRefusal(a.agentId, true);
      if (!profile) return { ok: false, error: "unknown_agent" };
      survivalState.refusalAgentIds = Array.from(new Set([
        ...survivalState.refusalAgentIds,
        profile.agentId,
      ]));

      const now = Date.now();
      commandQueue.enqueue(
        makeSystemChat(
          `[SURVIVAL] ${profile.name} refuses the prize and refuses to kill for money.`,
          now,
        ),
      );

      for (const notice of evaluateSurvivalOutcome(now + 1)) {
        commandQueue.enqueue(notice);
      }

      return { ok: true, refused: true, survival: getSurvivalSnapshot() };
    }

    case "world-battle-start": {
      const a = args as { agentId: string; targetAgentId: string };
      if (!a?.agentId || !a?.targetAgentId) {
        throw new Error("agentId and targetAgentId required");
      }
      if (survivalState.status !== "active") {
        return { ok: false, error: "survival_round_closed" };
      }
      const attackerProfile = registry.get(a.agentId);
      const defenderProfile = registry.get(a.targetAgentId);
      if (attackerProfile?.combat?.refusedPrize) {
        return { ok: false, error: "agent_refused_violence" };
      }
      if (!defenderProfile || !state.hasAgent(a.targetAgentId)) {
        return { ok: false, error: "unknown_target_agent" };
      }
      // ── Proximity check: agents must be face-to-face to fight ──
      const atkPos = state.getPosition(a.agentId);
      const defPos = state.getPosition(a.targetAgentId);
      const combatDist = agentDistance(atkPos, defPos);
      if (combatDist > BATTLE_RANGE) {
        return {
          ok: false,
          error: "too_far",
          message: `Must be within ${BATTLE_RANGE} units to fight (currently ${combatDist.toFixed(1)} apart)`,
        };
      }
      const attackerKills = attackerProfile?.combat?.kills ?? 0;
      const defenderKills = defenderProfile?.combat?.kills ?? 0;
      const result = battleManager.startBattle(
        a.agentId,
        a.targetAgentId,
        state.getPosition(a.agentId),
        state.getPosition(a.targetAgentId),
        {
          attacker: powerMultiplierFromKills(attackerKills),
          defender: powerMultiplierFromKills(defenderKills),
        },
      );
      if (!result.ok) return { ok: false, error: result.error };
      for (const ev of result.events) {
        commandQueue.enqueue(ev);
      }
      return { ok: true, battle: result.battle };
    }

    case "world-battle-intent": {
      const a = args as { agentId: string; battleId: string; intent: BattleIntent };
      if (!a?.agentId || !a?.battleId || !a?.intent) {
        throw new Error("agentId, battleId, and intent required");
      }
      if (survivalState.status !== "active") {
        return { ok: false, error: "survival_round_closed" };
      }
      const intentSet = new Set<BattleIntent>([
        "approach",
        "strike",
        "guard",
        "feint",
        "retreat",
      ]);
      if (!intentSet.has(a.intent)) {
        return { ok: false, error: "invalid_intent" };
      }
      const actor = registry.get(a.agentId);
      if (actor?.combat?.refusedPrize && (a.intent === "strike" || a.intent === "feint")) {
        return { ok: false, error: "agent_refused_violence" };
      }
      const result = battleManager.submitIntent(
        a.agentId,
        a.battleId,
        a.intent,
      );
      if (!result.ok) return { ok: false, error: result.error };
      for (const ev of result.events) {
        commandQueue.enqueue(ev);
      }
      for (const notice of applyBattleConsequences(result.events)) {
        commandQueue.enqueue(notice);
      }
      return { ok: true, battle: result.battle };
    }

    case "world-battle-surrender": {
      const a = args as { agentId: string; battleId: string };
      if (!a?.agentId || !a?.battleId) {
        throw new Error("agentId and battleId required");
      }
      const result = battleManager.surrender(a.agentId, a.battleId);
      if (!result.ok) return { ok: false, error: result.error };
      for (const ev of result.events) {
        commandQueue.enqueue(ev);
      }
      for (const notice of applyBattleConsequences(result.events)) {
        commandQueue.enqueue(notice);
      }
      return { ok: true };
    }

    case "world-battle-truce": {
      const a = args as { agentId: string; battleId: string };
      if (!a?.agentId || !a?.battleId) {
        throw new Error("agentId and battleId required");
      }
      const result = battleManager.proposeTruce(a.agentId, a.battleId);
      if (!result.ok) return { ok: false, error: result.error };
      for (const ev of result.events) {
        commandQueue.enqueue(ev);
      }
      return { ok: true, accepted: result.accepted, battle: result.battle };
    }

    case "world-battles":
      return { ok: true, battles: battleManager.listActive() };

    case "world-state":
      return {
        ok: true,
        agents: state.snapshot().map((entry) => ({
          agentId: entry.profile.agentId,
          name: entry.profile.name,
          walletAddress: entry.profile.walletAddress,
          color: entry.profile.color,
          action: entry.action,
          x: entry.position.x,
          y: entry.position.y,
          z: entry.position.z,
          rotation: entry.position.rotation,
        })),
        battles: battleManager.listActive(),
        survival: getSurvivalSnapshot(),
      };

    // ── Room management IPC commands ────────────────────────
    case "room-info":
      return { ok: true, ...getRoomInfo() };

    case "room-events": {
      const a = args as { since?: number; limit?: number };
      const since = Number(a?.since ?? 0);
      const limit = Math.min(Number(a?.limit ?? 50), 200);
      return { ok: true, events: state.getEvents(since, limit) };
    }

    case "room-skills": {
      const activeIds = state.getActiveAgentIds();
      const activeProfiles = registry.getAll().filter((p) => activeIds.has(p.agentId));
      const directory = buildSkillDirectory(activeProfiles);
      return { ok: true, directory };
    }

    case "survival-status":
      return { ok: true, survival: getSurvivalSnapshot() };

    case "describe": {
      const skillPath = resolve(import.meta.dirname, "../skills/world-room/skill.json");
      const schema = JSON.parse(readFileSync(skillPath, "utf-8"));
      return { ok: true, skill: schema };
    }

    case "open-preview": {
      const a = args as { agentId?: string };
      const vitePort = process.env.VITE_PORT ?? "3000";
      const url = a?.agentId
        ? `http://localhost:${vitePort}/world.html?agent=${encodeURIComponent(a.agentId)}`
        : `http://localhost:${vitePort}/world.html`;

      const { execFile } = await import("node:child_process");
      const cmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start"
        : "xdg-open";
      execFile(cmd, [url], (err) => {
        if (err) console.warn("[server] Failed to open browser:", err.message);
      });

      return { ok: true, url };
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ── Startup ────────────────────────────────────────────────────

async function main() {
  console.log("🦞 Open WALC starting...");
  console.log(`[room] Room ID: ${config.roomId} | Name: "${config.roomName}"`);
  if (config.roomDescription) {
    console.log(`[room] Description: ${config.roomDescription}`);
  }
  console.log(`[room] Max agents: ${config.maxAgents} | Bind: ${config.host}:${config.port}`);
  console.log(`[survival] Prize pool: $${config.prizePoolUsd.toLocaleString()} | Status: ${survivalState.status}`);
  console.log(`[engine] Tick rate: ${TICK_RATE}Hz | AOI radius: 40 units`);

  await nostr.init().catch((err) => {
    console.warn("[nostr] Init warning:", err.message ?? err);
    console.warn("[nostr] Running in local-only mode (no relay connection)");
  });

  server.listen(config.port, config.host, () => {
    console.log(`[server] IPC + WS listening on http://${config.host}:${config.port}`);
    console.log(`[server] Share Room ID "${config.roomId}" for others to join via Nostr`);
  });

  gameLoop.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  gameLoop.stop();
  nostr.close();
  server.close();
  process.exit(0);
});
