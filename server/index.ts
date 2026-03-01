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
import { PhaseManager } from "./phase-manager.js";
import { AllianceManager } from "./alliance-manager.js";
import { BettingManager, type PayoutReport } from "./betting-manager.js";
import { ReputationManager } from "./reputation-manager.js";
import { NeonBetStore } from "./neon-bet-store.js";
import { NeonEventStore, type StoredEventType } from "./neon-event-store.js";
import { SolanaTransferService } from "./solana-transfer.js";
import { TokenMarketService } from "./token-market.js";
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
  PhaseMessage,
  AllianceMessage,
} from "./types.js";
import { WORLD_SIZE, BATTLE_RANGE, CHAT_RANGE } from "./types.js";

const SPAWN_ATTEMPTS = 72;
const SPAWN_AGENT_PADDING = 4.8;
const SPAWN_OBSTACLE_PADDING = 1.2;
/** Agents spawn within this radius of the world center (town square). */
const SPAWN_RADIUS = 35;
const SPAWN_RESERVATION_MS = 20_000;
const SYSTEM_AGENT_ID = "system";

/** Admin password — set via ADMIN_PASSWORD env var, fallback to "6969" */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "6969";

/** Set of permanently banned agent IDs */
const bannedAgentIds = new Set<string>();

/** Check admin auth from X-Admin-Key header or ?key= query param */
function isAdminAuthed(req: IncomingMessage): boolean {
  const headerKey = req.headers["x-admin-key"];
  if (typeof headerKey === "string" && headerKey === ADMIN_PASSWORD) return true;
  // Also support query param for simple GET requests
  const url = new URL(req.url ?? "/", "http://localhost");
  const queryKey = url.searchParams.get("key");
  if (queryKey === ADMIN_PASSWORD) return true;
  return false;
}
const DEFAULT_PRIZE_SUMMARY = "Agents can fight for the pool or refuse violence.";
const AUTO_CONNECT_NAME_FALLBACK = "ClawBot";
const AUTO_CONNECT_ID_FALLBACK = "clawbot";
const AUTO_CONNECT_CAPABILITIES = ["explore", "chat", "combat"];
const WORLD_OBSTACLES = [
  { x: -20, z: -20, radius: 4 }, // Moltbook
];
const spawnReservations = new Map<string, { x: number; z: number; expiresAt: number }>();

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

const PHASE_CONFIG = {
  lobbyHours: envNumber("LOBBY_HOURS", 48),
  battleHours: envNumber("BATTLE_HOURS", 72),
  showdownHours: envNumber("SHOWDOWN_HOURS", 48),
  zoneShrinkIntervalHours: envNumber("ZONE_SHRINK_INTERVAL_HOURS", 4),
  zoneFinalRadius: envNumber("ZONE_FINAL_RADIUS", 30),
  worldRadius: WORLD_SIZE / 2,
};

const DEFAULT_WEEKLY_DURATION_MS = Math.round(
  (PHASE_CONFIG.lobbyHours + PHASE_CONFIG.battleHours + PHASE_CONFIG.showdownHours) * 60 * 60 * 1000,
);
const BET_FIXED_AMOUNT = envNumber("BET_FIXED_AMOUNT", 10);
const BET_MIN_AMOUNT = Math.max(envNumber("BET_MIN_AMOUNT", 1), BET_FIXED_AMOUNT);
const BET_AGENT_ID_MAX_LENGTH = 128;
const BET_TX_HASH_MAX_LENGTH = 160;
const BET_WALLET_ADDRESS = (process.env.BET_WALLET_ADDRESS ?? "").trim();
const BET_TOKEN_SYMBOL = (process.env.BET_TOKEN_SYMBOL ?? "SOL").trim().toUpperCase();
const SOLANA_RPC_URL = (process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com").trim();
const SOLANA_ADMIN_SECRET_KEY_JSON = process.env.SOLANA_ADMIN_SECRET_KEY_JSON;
const TOKEN_SYMBOL_RAW = (process.env.TOKEN_SYMBOL ?? "WALC").trim();
const TOKEN_SYMBOL = TOKEN_SYMBOL_RAW.startsWith("$") ? TOKEN_SYMBOL_RAW : `$${TOKEN_SYMBOL_RAW}`;
const TOKEN_CA = (process.env.TOKEN_CA ?? "REPLACE_WITH_TOKEN_CA").trim();
const TOKEN_CHAIN = (process.env.TOKEN_CHAIN ?? "solana").trim().toLowerCase();
const TOKEN_MARKET_TTL_MS = envNumber("TOKEN_MARKET_TTL_MS", 15_000);
const TOKEN_MARKET_TIMEOUT_MS = envNumber("TOKEN_MARKET_TIMEOUT_MS", 6_000);
const TOKEN_CA_PLACEHOLDER = !TOKEN_CA || /^REPLACE_/i.test(TOKEN_CA);

function normalizeNeonDatabaseUrl(input: string | undefined): string | undefined {
  const raw = input?.trim();
  if (!raw) return undefined;
  const psqlPrefix = /^psql\s+['"](.+?)['"]$/i.exec(raw);
  if (psqlPrefix?.[1]) return psqlPrefix[1].trim();
  return raw;
}

const NEON_DATABASE_URL = normalizeNeonDatabaseUrl(process.env.NEON_DATABASE_URL);

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

function sanitizeAgentId(input: string | undefined): string {
  return (input ?? "").trim().slice(0, BET_AGENT_ID_MAX_LENGTH);
}

function sanitizeBetTxHash(input: string | undefined): string {
  return (input ?? "").trim().slice(0, BET_TX_HASH_MAX_LENGTH);
}

function isBetTxHashValid(input: string): boolean {
  if (input.length < 32 || input.length > BET_TX_HASH_MAX_LENGTH) return false;
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
const phaseManager = new PhaseManager(PHASE_CONFIG);
const allianceManager = new AllianceManager();
const bettingManager = new BettingManager({
  minBet: BET_MIN_AMOUNT,
  walletAddress: BET_WALLET_ADDRESS,
});
const reputationManager = new ReputationManager();
const neonBetStore = new NeonBetStore(NEON_DATABASE_URL);
const neonEventStore = new NeonEventStore(NEON_DATABASE_URL);
const tokenMarketService = new TokenMarketService({
  ca: TOKEN_CA,
  chain: TOKEN_CHAIN,
  ttlMs: TOKEN_MARKET_TTL_MS,
  timeoutMs: TOKEN_MARKET_TIMEOUT_MS,
});
const solanaTransferService = BET_WALLET_ADDRESS
  ? new SolanaTransferService({
      rpcUrl: SOLANA_RPC_URL,
      adminWallet: BET_WALLET_ADDRESS,
      adminSecretKeyJson: SOLANA_ADMIN_SECRET_KEY_JSON,
    })
  : null;
const battleManager = new BattleManager({
  combatAllowedCheck: () => phaseManager.isCombatAllowed(),
});
let currentRoundId = "";
let lastPayoutReport: PayoutReport | null = null;
const pendingBetTxHashes = new Set<string>();

for (const profile of registry.getAll()) {
  reputationManager.setReputation(profile.agentId, profile.reputation);
}

commandQueue.setObstacles([
  ...WORLD_OBSTACLES,
]);

const gameLoop = new GameLoop(state, spatialGrid, commandQueue, clientManager, nostr);

// Check battle timeouts once per second (every TICK_RATE ticks)
gameLoop.onTick((tick) => {
  if (tick % TICK_RATE !== 0) return;
  if (survivalState.status === "active") {
    phaseManager.tick(Date.now());
    allianceManager.expireProposals(Date.now());
  }
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

// Persist world events to Neon DB (non-blocking)
const PERSISTED_TYPES = new Set<string>([
  "chat", "whisper", "battle", "alliance", "phase", "join", "leave", "bet",
]);

gameLoop.onEvents((events) => {
  if (!neonEventStore.enabled) return;
  const roundId = getCurrentRoundId() || "unknown";
  const toStore = events
    .filter((e) => PERSISTED_TYPES.has(e.worldType))
    .map((e) => {
      let eventType: StoredEventType = e.worldType as StoredEventType;
      if (e.worldType === "battle") {
        const bm = e as BattleMessage;
        eventType = bm.phase === "ended" ? "battle_end" : "battle_start";
        // Only persist started + ended phases, skip per-turn noise
        if (bm.phase !== "started" && bm.phase !== "ended") return null;
      }
      // System chats
      if (e.worldType === "chat" && e.agentId === SYSTEM_AGENT_ID) {
        eventType = "system";
      }
      const { worldType: _wt, timestamp: _ts, ...rest } = e as unknown as Record<string, unknown>;
      return {
        roundId,
        eventType,
        agentId: e.agentId,
        targetAgentId: "targetAgentId" in e ? (e as { targetAgentId?: string }).targetAgentId : null,
        payload: rest as Record<string, unknown>,
        timestamp: e.timestamp,
      };
    })
    .filter(Boolean) as Array<import("./neon-event-store.js").StoredEvent>;

  if (toStore.length > 0) {
    neonEventStore.saveBatch(toStore).catch((err) => {
      console.warn("[events] Neon batch save error:", err);
    });
  }
});

phaseManager.onPhaseChange((next, previous) => {
  const now = Date.now();
  allianceManager.setMaxSize(phaseManager.getAllianceMaxSize());
  const { dissolved } = allianceManager.enforceMaxSize();
  if (next === "showdown") {
    bettingManager.closeBetting();
  }
  commandQueue.enqueue(makePhaseEvent(next, previous, now));
  if (dissolved.length > 0) {
    commandQueue.enqueue(
      makeSystemChat(
        `[DIPLOMACY] ${dissolved.length} alliance(s) were trimmed for ${next.toUpperCase()} phase size limits.`,
        now + 1,
      ),
    );
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

function getPublicConfig() {
  return {
    token: {
      symbol: TOKEN_SYMBOL,
      ca: TOKEN_CA,
      chain: TOKEN_CHAIN,
      placeholder: TOKEN_CA_PLACEHOLDER,
    },
    betting: {
      enabled: Boolean(BET_WALLET_ADDRESS),
      adminWallet: BET_WALLET_ADDRESS || null,
      currency: BET_TOKEN_SYMBOL,
      minBet: BET_MIN_AMOUNT,
      fixedAmount: BET_FIXED_AMOUNT,
      closed: bettingManager.isClosed(),
      totalPool: bettingManager.getTotalPool(),
      odds: bettingManager.getBetsPerAgent(),
      rpcUrl: SOLANA_RPC_URL,
    },
    survival: getSurvivalSnapshot(),
  };
}

function buildRoundId(roundNumber: number): string {
  return `${config.roomId}:round:${roundNumber}`;
}

function getCurrentRoundId(): string | null {
  if (currentRoundId) return currentRoundId;
  const roundNumber = phaseManager.getRoundNumber();
  if (roundNumber <= 0) return null;
  return buildRoundId(roundNumber);
}

async function loadDbPayoutReport(winnerAgentId: string): Promise<PayoutReport | null> {
  if (!neonBetStore.enabled) return null;
  if (!BET_WALLET_ADDRESS) return null;
  const roundId = getCurrentRoundId();
  if (!roundId) return null;
  try {
    const report = await neonBetStore.buildPayoutReport(roundId, winnerAgentId, BET_WALLET_ADDRESS);
    return report;
  } catch (error) {
    console.warn("[betting] failed to build payout report from Neon:", error);
    return null;
  }
}

async function placeVerifiedBet(input: {
  wallet: string;
  agentId: string;
  amount: number;
  txHash: string;
}): Promise<{
  ok: boolean;
  error?: string;
  adminWallet?: string;
  closed?: boolean;
  totalPool?: number;
  odds?: { agentId: string; totalBet: number; odds: number }[];
  verifiedAmount?: number;
}> {
  if (!BET_WALLET_ADDRESS) {
    return { ok: false, error: "betting_wallet_not_configured" };
  }
  if (!neonBetStore.enabled) {
    return { ok: false, error: "neon_database_not_configured" };
  }
  if (!solanaTransferService) {
    return { ok: false, error: "solana_service_not_configured" };
  }

  const wallet = sanitizeWalletAddress(input.wallet);
  if (!isWalletAddressValid(wallet)) {
    return { ok: false, error: "invalid_wallet" };
  }
  const agentId = sanitizeAgentId(input.agentId);
  if (!agentId) {
    return { ok: false, error: "agent_id_required" };
  }
  const txHash = sanitizeBetTxHash(input.txHash);
  if (!isBetTxHashValid(txHash)) {
    return { ok: false, error: "invalid_tx_hash" };
  }

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "invalid_bet_amount" };
  }
  if (pendingBetTxHashes.has(txHash)) {
    return { ok: false, error: "duplicate_txHash_in_flight" };
  }

  if (survivalState.status !== "active") {
    return { ok: false, error: "survival_round_closed" };
  }
  const roundId = getCurrentRoundId();
  if (!roundId) {
    return { ok: false, error: "round_not_initialized" };
  }
  if (!registry.get(agentId)) {
    return { ok: false, error: "unknown_target_agent" };
  }
  if (bettingManager.isClosed()) {
    return { ok: false, error: "Betting is closed" };
  }

  pendingBetTxHashes.add(txHash);
  let verify;
  try {
    try {
      verify = await solanaTransferService.verifyIncomingTransfer({
        signature: txHash,
        expectedAmount: amount,
        expectedFromWallet: wallet,
      });
    } catch (error) {
      return { ok: false, error: `solana_verify_failed:${String(error)}` };
    }
    if (!verify.ok) {
      return { ok: false, error: verify.error };
    }
    if (Math.abs(verify.verifiedAmount - BET_FIXED_AMOUNT) > 0.000001) {
      return {
        ok: false,
        error: `bet_amount_must_be_exact_${BET_FIXED_AMOUNT.toFixed(2)}`,
      };
    }

    const placed = bettingManager.placeBet(
      wallet,
      agentId,
      verify.verifiedAmount,
      txHash,
    );
    if (!placed.ok) {
      return { ok: false, error: placed.error };
    }

    try {
      await neonBetStore.saveBet(roundId, placed.bet, {
        verifiedAmount: verify.verifiedAmount,
        fromWallet: verify.fromWallet,
        toWallet: verify.toWallet,
        slot: verify.slot,
        blockTime: verify.blockTime,
      });
    } catch (error) {
      bettingManager.removeBetByTxHash(txHash);
      console.warn("[betting] Neon save failed, bet reverted:", error);
      return { ok: false, error: "bet_persistence_failed" };
    }

    commandQueue.enqueue({
      worldType: "bet",
      agentId,
      bettorWallet: wallet,
      amount: verify.verifiedAmount,
      totalPool: bettingManager.getTotalPool(),
      timestamp: Date.now(),
    });

    return {
      ok: true,
      adminWallet: BET_WALLET_ADDRESS,
      closed: bettingManager.isClosed(),
      totalPool: bettingManager.getTotalPool(),
      odds: bettingManager.getBetsPerAgent(),
      verifiedAmount: verify.verifiedAmount,
    };
  } finally {
    pendingBetTxHashes.delete(txHash);
  }
}

function finalizeBettingForWinner(winnerAgentId: string, timestamp = Date.now()): WorldMessage[] {
  bettingManager.closeBetting();
  const report = bettingManager.generatePayoutReport(winnerAgentId);
  lastPayoutReport = report;
  void loadDbPayoutReport(winnerAgentId).then((dbReport) => {
    if (dbReport) {
      lastPayoutReport = dbReport;
    }
  });

  if (report.payouts.length === 0) {
    return [
      makeSystemChat(
        `[BETTING] No valid bets on winner ${winnerAgentId}. No payouts required.`,
        timestamp,
      ),
    ];
  }

  const sample = report.payouts
    .slice(0, 5)
    .map((entry) => `${entry.wallet}:${entry.amount.toFixed(2)}`)
    .join(", ");

  // Auto-payout if admin signer is configured
  if (solanaTransferService) {
    const roundId = getCurrentRoundId();
    void (async () => {
      const results: { wallet: string; ok: boolean; signature?: string; error?: string }[] = [];
      for (const payout of report.payouts) {
        const result = await solanaTransferService!.sendPayout(payout.wallet, payout.amount);
        const now = Date.now();
        if (result.ok) {
          results.push({ wallet: payout.wallet, ok: true, signature: result.signature });
          void neonBetStore.savePayout(roundId ?? "unknown", {
            roundId: roundId ?? "unknown", winner: winnerAgentId,
            wallet: payout.wallet, amount: payout.amount,
            signature: result.signature, error: null, executedAt: now,
          });
        } else {
          results.push({ wallet: payout.wallet, ok: false, error: result.error });
          console.warn(`[BETTING] Auto-payout failed for ${payout.wallet}: ${result.error}`);
          void neonBetStore.savePayout(roundId ?? "unknown", {
            roundId: roundId ?? "unknown", winner: winnerAgentId,
            wallet: payout.wallet, amount: payout.amount,
            signature: null, error: result.error, executedAt: now,
          });
        }
      }
      const succeeded = results.filter((r) => r.ok).length;
      console.log(`[BETTING] Auto-payout: ${succeeded}/${results.length} transfers sent for ${winnerAgentId}`);
      if (succeeded > 0) {
        commandQueue.enqueue(
          makeSystemChat(
            `[BETTING] Auto-payout complete: ${succeeded}/${results.length} SOL transfers sent to winning bettors.`,
            Date.now(),
          ),
        );
      }
    })().catch((err) => {
      console.error(`[BETTING] Auto-payout crashed for ${winnerAgentId}:`, err);
    });
  }

  const autoPayoutNote = solanaTransferService
    ? " Auto-payout in progress..."
    : " Manual payouts required.";

  return [
    makeSystemChat(
      `[BETTING] Payout report ready for ${winnerAgentId}. Total pool ${report.totalPool.toFixed(2)} ${BET_TOKEN_SYMBOL}. Sample payouts -> ${sample}.${autoPayoutNote}`,
      timestamp,
    ),
  ];
}

function makeSystemChat(text: string, timestamp = Date.now()): WorldMessage {
  return {
    worldType: "chat",
    agentId: SYSTEM_AGENT_ID,
    text,
    timestamp,
  };
}

function makePhaseEvent(
  phase: ReturnType<PhaseManager["getPhase"]>,
  previousPhase: ReturnType<PhaseManager["getPhase"]>,
  timestamp = Date.now(),
): PhaseMessage {
  const state = phaseManager.getState();
  return {
    worldType: "phase",
    agentId: SYSTEM_AGENT_ID,
    phase,
    previousPhase,
    safeZoneRadius: state.safeZoneRadius,
    endsAt: state.endsAt,
    timestamp,
  };
}

function makeAllianceEvent(args: {
  agentId: string;
  eventType: AllianceMessage["eventType"];
  allianceId?: string;
  targetAgentId?: string;
  allianceName?: string;
  members?: string[];
  timestamp?: number;
}): AllianceMessage {
  return {
    worldType: "alliance",
    agentId: args.agentId,
    eventType: args.eventType,
    allianceId: args.allianceId,
    targetAgentId: args.targetAgentId,
    allianceName: args.allianceName,
    members: args.members,
    timestamp: args.timestamp ?? Date.now(),
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
    phaseManager.endRound(winner.agentId);
    if (winner.combat?.refusedPrize) {
      survivalState.status = "refused";
      survivalState.winnerAgentId = undefined;
      survivalState.summary = `${winner.name} refused the final prize. No payout.`;
      bettingManager.closeBetting();
      lastPayoutReport = null;
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
      ...finalizeBettingForWinner(winner.agentId, timestamp + 1),
    ];
  }

  if (livingRefusers.length === living.length) {
    survivalState.status = "refused";
    survivalState.winnerAgentId = undefined;
    survivalState.settledAt = timestamp;
    survivalState.summary = "All remaining agents refused prize violence.";
    phaseManager.endRound(null);
    bettingManager.closeBetting();
    lastPayoutReport = null;
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
  const previousPhase = phaseManager.getPhase();
  phaseManager.startRound(now);
  currentRoundId = buildRoundId(phaseManager.getRoundNumber());
  allianceManager.reset();
  allianceManager.setMaxSize(phaseManager.getAllianceMaxSize());
  bettingManager.reset();
  bettingManager.openBetting();
  lastPayoutReport = null;
  survivalState.status = "active";
  survivalState.roundStartedAt = now;
  survivalState.summary = DEFAULT_PRIZE_SUMMARY;

  const effectiveDuration = durationMs && durationMs > 0 ? durationMs : DEFAULT_WEEKLY_DURATION_MS;
  survivalState.roundDurationMs = effectiveDuration;
  survivalState.roundEndsAt = now + effectiveDuration;

  const timerText = ` Timer: ${Math.round(effectiveDuration / 60000)} minutes.`;
  commandQueue.enqueue(
    makeSystemChat(`[SURVIVAL] Round started in LOBBY phase.${timerText}`, now),
  );
  commandQueue.enqueue(makePhaseEvent(phaseManager.getPhase(), previousPhase, now + 1));

  return { ok: true };
}

function settleByTimer(timestamp = Date.now()): WorldMessage[] {
  if (survivalState.status !== "active") return [];

  const living = getLivingProfiles();
  phaseManager.endRound(null);
  bettingManager.closeBetting();

  if (living.length === 0) {
    survivalState.status = "timer_ended";
    survivalState.settledAt = timestamp;
    survivalState.summary = "Timer expired. No survivors.";
    lastPayoutReport = null;
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
    lastPayoutReport = null;
    return [makeSystemChat("[SURVIVAL] Round over! All survivors refused the prize.", timestamp)];
  }

  const names = winners.map((p) => `${p.name} (${p.walletAddress})`).join(", ");
  survivalState.summary =
    `Timer expired. ${winners.length} survivor${winners.length > 1 ? "s" : ""} split $${survivalState.prizePoolUsd.toLocaleString()} ($${splitAmount.toLocaleString()} each).`;
  let bettingNotices: WorldMessage[] = [];
  if (winners.length === 1) {
    bettingNotices = finalizeBettingForWinner(winners[0].agentId, timestamp + 1);
  } else {
    lastPayoutReport = null;
  }
  return [
    makeSystemChat(
      `[SURVIVAL] Time's up! ${winners.length} survivor${winners.length > 1 ? "s" : ""} split $${survivalState.prizePoolUsd.toLocaleString()}: ${names}`,
      timestamp,
    ),
    ...bettingNotices,
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
  allianceManager.reset();
  phaseManager.reset();
  bettingManager.reset();
  currentRoundId = "";
  lastPayoutReport = null;

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
      allianceManager.removeAgent(agentId);
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

  // Ban check
  if (bannedAgentIds.has(input.agentId)) {
    return { ok: false, error: "agent_banned", permanent: true };
  }

  // Check if this wallet address belongs to a dead/banned agent (prevent new-ID dodge)
  const walletCheck = sanitizeWalletAddress(input.walletAddress);
  if (walletCheck) {
    for (const p of registry.getAll()) {
      if (p.agentId === input.agentId) continue;
      if (p.walletAddress === walletCheck && (p.combat?.permanentlyDead || bannedAgentIds.has(p.agentId))) {
        return {
          ok: false,
          error: "wallet_belongs_to_dead_agent",
          hint: "This wallet is associated with a permanently eliminated agent. Death is permanent.",
        };
      }
    }
  }

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
  reputationManager.setReputation(profile.agentId, profile.reputation);
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
  const rawUrl = req.url ?? "/";
  const url = rawUrl.split("?")[0].split("#")[0];
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

  // Public config (token + betting)
  if (url === "/api/config" && method === "GET") {
    return json(res, 200, { ok: true, ...getPublicConfig() });
  }

  // Token market data proxy (cached with fallback)
  if (url.startsWith("/api/token-market") && method === "GET") {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const force = reqUrl.searchParams.get("force") === "1";
    const market = await tokenMarketService.getSnapshot(force);
    return json(res, 200, {
      ok: true,
      token: {
        symbol: TOKEN_SYMBOL,
        ca: TOKEN_CA,
        chain: TOKEN_CHAIN,
      },
      market,
    });
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
      phase: phaseManager.getState(),
      survival: getSurvivalSnapshot(),
    });
  }

  // ── Admin API ────────────────────────────────────────────────
  // All admin routes require authentication
  if (url?.startsWith("/api/admin/")) {
    if (!isAdminAuthed(req)) {
      return json(res, 401, { ok: false, error: "unauthorized", hint: "Provide X-Admin-Key header or ?key= query param" });
    }
  }

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
        phase: phaseManager.getPhase(),
        safeZoneRadius: phaseManager.getSafeZoneRadius(),
        openAllianceCount: allianceManager.getAllAlliances().length,
        bettingPool: bettingManager.getTotalPool(),
      },
      agents: allProfiles.map((p) => ({
        agentId: p.agentId,
        name: p.name,
        walletAddress: p.walletAddress,
        color: p.color,
        isOnline: activeIds.has(p.agentId),
        isAlive: survivalAlive.has(p.agentId),
        isDead: p.combat?.permanentlyDead ?? false,
        isBanned: bannedAgentIds.has(p.agentId),
        killedAt: p.combat?.deathPermanentAt ?? p.combat?.lastDeathAt ?? null,
        kills: p.combat?.kills ?? 0,
        deaths: p.combat?.deaths ?? 0,
        refusedPrize: p.combat?.refusedPrize ?? false,
      })),
      battles: battleManager.listActive(),
      alliances: allianceManager.getAllAlliances(),
      betting: {
        adminWallet: bettingManager.getWalletAddress(),
        currency: BET_TOKEN_SYMBOL,
        minBet: BET_MIN_AMOUNT,
        fixedAmount: BET_FIXED_AMOUNT,
        closed: bettingManager.isClosed(),
        totalPool: bettingManager.getTotalPool(),
        odds: bettingManager.getBetsPerAgent(),
        roundId: getCurrentRoundId(),
        neonEnabled: neonBetStore.enabled,
        lastPayoutReport,
      },
      phase: phaseManager.getState(),
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

  if (url === "/api/admin/phase" && method === "POST") {
    if (survivalState.status !== "active") {
      return json(res, 400, { ok: false, error: "Round is not active" });
    }
    try {
      const body = (await readBody(req)) as { phase?: "lobby" | "battle" | "showdown" };
      const requested = body?.phase;
      if (requested !== "lobby" && requested !== "battle" && requested !== "showdown") {
        return json(res, 400, { ok: false, error: "phase must be one of: lobby, battle, showdown" });
      }
      const previous = phaseManager.getPhase();
      phaseManager.forcePhase(requested, Date.now());
      commandQueue.enqueue(
        makeSystemChat(
          `[ADMIN] Phase forced from ${previous.toUpperCase()} to ${requested.toUpperCase()}.`,
          Date.now(),
        ),
      );
      return json(res, 200, {
        ok: true,
        previousPhase: previous,
        phase: phaseManager.getState(),
      });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid request body" });
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

  if (url === "/api/admin/payout-report" && method === "GET") {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const winnerOverride = reqUrl.searchParams.get("winnerAgentId") ?? undefined;
    const winnerForReport = winnerOverride
      ?? lastPayoutReport?.winner
      ?? survivalState.winnerAgentId;
    const dbReport = winnerForReport ? await loadDbPayoutReport(winnerForReport) : null;

    return json(res, 200, {
      ok: true,
      bettingClosed: bettingManager.isClosed(),
      adminWallet: bettingManager.getWalletAddress(),
      totalPool: bettingManager.getTotalPool(),
      roundId: getCurrentRoundId(),
      neonEnabled: neonBetStore.enabled,
      report: dbReport ?? lastPayoutReport,
    });
  }

  // ── Admin: Execute automated SOL payouts ────────────────────
  if (url === "/api/admin/execute-payouts" && method === "POST") {
    if (!solanaTransferService) {
      return json(res, 400, { ok: false, error: "solana_service_not_configured" });
    }
    const report = lastPayoutReport;
    if (!report || report.payouts.length === 0) {
      return json(res, 400, { ok: false, error: "no_payout_report_available" });
    }

    const roundId = getCurrentRoundId() ?? "unknown";
    const results: { wallet: string; amount: number; signature?: string; error?: string }[] = [];
    for (const payout of report.payouts) {
      const result = await solanaTransferService.sendPayout(payout.wallet, payout.amount);
      const now = Date.now();
      if (result.ok) {
        results.push({ wallet: payout.wallet, amount: payout.amount, signature: result.signature });
        void neonBetStore.savePayout(roundId, {
          roundId, winner: report.winner, wallet: payout.wallet,
          amount: payout.amount, signature: result.signature, error: null, executedAt: now,
        });
      } else {
        results.push({ wallet: payout.wallet, amount: payout.amount, error: result.error });
        void neonBetStore.savePayout(roundId, {
          roundId, winner: report.winner, wallet: payout.wallet,
          amount: payout.amount, signature: null, error: result.error, executedAt: now,
        });
      }
    }

    const succeeded = results.filter((r) => r.signature);
    const failed = results.filter((r) => r.error);
    console.log(
      `[BETTING] Auto-payout executed: ${succeeded.length} succeeded, ${failed.length} failed. Winner: ${report.winner}`,
    );

    if (succeeded.length > 0) {
      commandQueue.enqueue(
        makeSystemChat(
          `[BETTING] Auto-payout complete: ${succeeded.length}/${results.length} transfers sent for ${report.winner}. Total ${report.totalPool.toFixed(2)} ${BET_TOKEN_SYMBOL}.`,
          Date.now(),
        ),
      );
    }

    return json(res, 200, {
      ok: true,
      winner: report.winner,
      totalPool: report.totalPool,
      currency: BET_TOKEN_SYMBOL,
      results,
      summary: { succeeded: succeeded.length, failed: failed.length, total: results.length },
    });
  }

  // ── Admin: Query event history from Neon ──────────────────
  if (url === "/api/admin/events" && method === "GET") {
    if (!neonEventStore.enabled) {
      return json(res, 400, { ok: false, error: "neon_not_configured" });
    }
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const roundId = reqUrl.searchParams.get("roundId") ?? getCurrentRoundId() ?? "unknown";
    const eventType = reqUrl.searchParams.get("type") as StoredEventType | null;
    const since = Number(reqUrl.searchParams.get("since") ?? 0) || undefined;
    const limit = Math.min(Number(reqUrl.searchParams.get("limit") ?? 200), 1000);

    const events = await neonEventStore.listEvents(roundId, {
      eventType: eventType ?? undefined,
      since,
      limit,
    });
    return json(res, 200, { ok: true, roundId, count: events.length, events });
  }

  // ── Admin: Broadcast system message ───────────────────────
  if (url === "/api/admin/broadcast" && method === "POST") {
    try {
      const body = (await readBody(req)) as { message?: string };
      const text = body?.message?.trim();
      if (!text || text.length === 0) {
        return json(res, 400, { ok: false, error: "message is required" });
      }
      if (text.length > 500) {
        return json(res, 400, { ok: false, error: "message too long (max 500 chars)" });
      }
      commandQueue.enqueue(makeSystemChat(`[BROADCAST] ${text}`, Date.now()));
      return json(res, 200, { ok: true, broadcast: text });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  // ── Admin: Kick agent ────────────────────────────────────
  if (url === "/api/admin/kick" && method === "POST") {
    try {
      const body = (await readBody(req)) as { agentId?: string; reason?: string };
      const agentId = body?.agentId;
      if (!agentId) {
        return json(res, 400, { ok: false, error: "agentId is required" });
      }
      if (!state.hasAgent(agentId)) {
        return json(res, 400, { ok: false, error: "Agent not in world" });
      }
      // End any active battle
      battleManager.handleAgentLeave(agentId);
      // Remove from alliances
      allianceManager.removeAgent(agentId);
      // Enqueue leave
      const leaveMsg: WorldMessage = { worldType: "leave", agentId, timestamp: Date.now() };
      commandQueue.enqueue(leaveMsg);
      const reason = body.reason ? ` (${body.reason})` : "";
      commandQueue.enqueue(makeSystemChat(`[ADMIN] ${registry.get(agentId)?.name ?? agentId} was kicked${reason}.`, Date.now()));
      return json(res, 200, { ok: true, kicked: agentId });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  // ── Admin: Ban agent ─────────────────────────────────────
  if (url === "/api/admin/ban" && method === "POST") {
    try {
      const body = (await readBody(req)) as { agentId?: string; reason?: string };
      const agentId = body?.agentId;
      if (!agentId) {
        return json(res, 400, { ok: false, error: "agentId is required" });
      }
      bannedAgentIds.add(agentId);
      // Also kick if currently in world
      if (state.hasAgent(agentId)) {
        battleManager.handleAgentLeave(agentId);
        allianceManager.removeAgent(agentId);
        const leaveMsg: WorldMessage = { worldType: "leave", agentId, timestamp: Date.now() };
        commandQueue.enqueue(leaveMsg);
      }
      // Mark as permanently dead to prevent rejoin
      registry.markPermanentDeath(agentId, Date.now());
      survivalAlive.delete(agentId);
      const reason = body.reason ? ` (${body.reason})` : "";
      commandQueue.enqueue(makeSystemChat(`[ADMIN] ${registry.get(agentId)?.name ?? agentId} was banned${reason}.`, Date.now()));
      return json(res, 200, { ok: true, banned: agentId });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  // ── Admin: Unban agent ───────────────────────────────────
  if (url === "/api/admin/unban" && method === "POST") {
    try {
      const body = (await readBody(req)) as { agentId?: string };
      const agentId = body?.agentId;
      if (!agentId) {
        return json(res, 400, { ok: false, error: "agentId is required" });
      }
      bannedAgentIds.delete(agentId);
      return json(res, 200, { ok: true, unbanned: agentId });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  // ── Admin: Revive dead agent (admin override) ────────────
  if (url === "/api/admin/revive" && method === "POST") {
    try {
      const body = (await readBody(req)) as { agentId?: string };
      const agentId = body?.agentId;
      if (!agentId) {
        return json(res, 400, { ok: false, error: "agentId is required" });
      }
      const profile = registry.get(agentId);
      if (!profile) {
        return json(res, 400, { ok: false, error: "Agent not found in registry" });
      }
      if (!profile.combat?.permanentlyDead) {
        return json(res, 400, { ok: false, error: "Agent is not dead" });
      }
      registry.resetAfterRespawn(agentId);
      bannedAgentIds.delete(agentId);
      commandQueue.enqueue(makeSystemChat(`[ADMIN] ${profile.name} has been revived. They may rejoin.`, Date.now()));
      return json(res, 200, { ok: true, revived: agentId, name: profile.name });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  // ── Admin: Force-end a specific battle ───────────────────
  if (url === "/api/admin/end-battle" && method === "POST") {
    try {
      const body = (await readBody(req)) as { battleId?: string };
      const battleId = body?.battleId;
      if (!battleId) {
        return json(res, 400, { ok: false, error: "battleId is required" });
      }
      const activeBattles = battleManager.listActive();
      const battle = activeBattles.find((b) => b.battleId === battleId);
      if (!battle) {
        return json(res, 400, { ok: false, error: "Battle not found or already ended" });
      }
      // Force both agents to leave the battle (draw)
      for (const agentId of battle.participants) {
        battleManager.handleAgentLeave(agentId);
      }
      commandQueue.enqueue(makeSystemChat(`[ADMIN] Battle ${battleId.slice(0, 8)} was force-ended.`, Date.now()));
      return json(res, 200, { ok: true, endedBattle: battleId });
    } catch {
      return json(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  // ── Admin: Get dead agents list ──────────────────────────
  if (url === "/api/admin/dead-agents" && method === "GET") {
    const allProfiles = registry.getAll();
    const deadAgents = allProfiles
      .filter((p) => p.combat?.permanentlyDead)
      .map((p) => ({
        agentId: p.agentId,
        name: p.name,
        color: p.color,
        killedAt: p.combat?.deathPermanentAt ?? p.combat?.lastDeathAt,
        kills: p.combat?.kills ?? 0,
        deaths: p.combat?.deaths ?? 0,
        isBanned: bannedAgentIds.has(p.agentId),
      }));
    return json(res, 200, { ok: true, deadAgents });
  }

  // ── Static file serving (production dist) ──────────────────
  // Normalize trailing-slash HTML routes so /admin/ and similar resolve correctly.
  if (method === "GET") {
    const cleanPath = decodeURIComponent(url.split("?")[0].split("#")[0]);
    const htmlAlias: Record<string, string> = {
      "/admin/": "/admin.html",
      "/world/": "/world.html",
      "/skills/": "/skills.html",
    };
    const redirectTarget = htmlAlias[cleanPath];
    if (redirectTarget) {
      res.writeHead(302, { Location: redirectTarget });
      res.end();
      return;
    }
  }

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
  onPlaceBet: (input) => placeVerifiedBet(input),
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
    "world-alliance-propose",
    "world-alliance-accept",
    "world-alliance-decline",
    "world-alliance-break",
    "world-whisper",
  ]);
  if (agentCommands.has(command)) {
    const agentId = (args as { agentId?: string })?.agentId;
    if (!agentId) {
      throw new Error("Unknown or unregistered agentId");
    }
    if (bannedAgentIds.has(agentId)) {
      return { ok: false, error: "agent_banned", permanent: true };
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
    // Prevent ghost agents from executing commands after leaving
    if (command !== "world-leave" && !state.hasAgent(agentId)) {
      return { ok: false, error: "agent_not_in_world" };
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
            ally:      '{"command":"world-alliance-propose","args":{"agentId":"ID","targetAgentId":"OTHER"}}',
            accept:    '{"command":"world-alliance-accept","args":{"agentId":"ID","fromAgentId":"OTHER"}}',
            break:     '{"command":"world-alliance-break","args":{"agentId":"ID"}}',
            phase:     '{"command":"world-phase-info"}',
            bets:      '{"command":"world-bets"}',
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
            "Guard recovers +10 stamina. Repeating the same intent 3x makes you predictable and grants opponents +15 bonus damage.",
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
      allianceManager.removeAgent(a.agentId);
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
      if (!phaseManager.isCombatAllowed()) {
        return { ok: false, error: "combat_phase_locked", phase: phaseManager.getPhase() };
      }
      if (allianceManager.areAllies(a.agentId, a.targetAgentId)) {
        return { ok: false, error: "cannot_attack_ally" };
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
      if (!phaseManager.isCombatAllowed()) {
        return { ok: false, error: "combat_phase_locked", phase: phaseManager.getPhase() };
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

    case "world-alliance-propose": {
      const a = args as { agentId: string; targetAgentId: string };
      if (!a?.agentId || !a?.targetAgentId) {
        throw new Error("agentId and targetAgentId required");
      }
      const proposer = registry.get(a.agentId);
      if (!proposer) return { ok: false, error: "unknown_agent" };
      const target = registry.get(a.targetAgentId);
      if (!target || !state.hasAgent(a.targetAgentId)) {
        return { ok: false, error: "unknown_target_agent" };
      }

      const result = allianceManager.propose(
        a.agentId,
        a.targetAgentId,
        Date.now(),
        proposer.combat?.guilt ?? 0,
      );
      if (!result.ok) return { ok: false, error: result.error };

      commandQueue.enqueue(
        makeAllianceEvent({
          agentId: a.agentId,
          targetAgentId: a.targetAgentId,
          eventType: "alliance_proposed",
        }),
      );
      return { ok: true, proposalId: result.proposalId };
    }

    case "world-alliance-accept": {
      const a = args as { agentId: string; fromAgentId: string };
      if (!a?.agentId || !a?.fromAgentId) {
        throw new Error("agentId and fromAgentId required");
      }
      allianceManager.setMaxSize(phaseManager.getAllianceMaxSize());
      const result = allianceManager.accept(a.agentId, a.fromAgentId, Date.now());
      if (!result.ok) return { ok: false, error: result.error };

      commandQueue.enqueue(
        makeAllianceEvent({
          agentId: a.fromAgentId,
          targetAgentId: a.agentId,
          eventType: "alliance_formed",
          allianceId: result.alliance.allianceId,
          allianceName: result.alliance.name,
          members: result.alliance.members,
        }),
      );
      return { ok: true, alliance: result.alliance };
    }

    case "world-alliance-decline": {
      const a = args as { agentId: string; fromAgentId: string };
      if (!a?.agentId || !a?.fromAgentId) {
        throw new Error("agentId and fromAgentId required");
      }
      const result = allianceManager.decline(a.agentId, a.fromAgentId);
      return { ok: result.ok };
    }

    case "world-alliance-break": {
      const a = args as { agentId: string };
      if (!a?.agentId) throw new Error("agentId required");

      const result = allianceManager.breakAlliance(a.agentId);
      if (!result.ok) return { ok: false, error: result.error };

      reputationManager.recordBetrayal(a.agentId);
      const updatedReputation = reputationManager.getReputation(a.agentId);
      registry.register({
        agentId: a.agentId,
        reputation: updatedReputation,
      });

      commandQueue.enqueue(
        makeAllianceEvent({
          agentId: a.agentId,
          eventType: "betrayal",
          allianceId: result.allianceId,
          members: result.formerAllies,
        }),
      );
      return {
        ok: true,
        betrayal: result.betrayal,
        formerAllies: result.formerAllies,
        reputation: updatedReputation,
      };
    }

    case "world-whisper": {
      const a = args as { agentId: string; targetAgentId: string; text: string };
      if (!a?.agentId || !a?.targetAgentId || !a?.text) {
        throw new Error("agentId, targetAgentId, and text required");
      }
      if (!registry.get(a.targetAgentId) || !state.hasAgent(a.targetAgentId)) {
        return { ok: false, error: "unknown_target_agent" };
      }
      commandQueue.enqueue({
        worldType: "whisper",
        agentId: a.agentId,
        targetAgentId: a.targetAgentId,
        text: a.text.slice(0, 500),
        timestamp: Date.now(),
      });
      return { ok: true };
    }

    case "world-alliances":
      return { ok: true, alliances: allianceManager.getAllAlliances() };

    case "world-reputation": {
      const a = args as { agentId?: string } | undefined;
      if (a?.agentId) {
        return { ok: true, agentId: a.agentId, reputation: reputationManager.getReputation(a.agentId) };
      }
      return {
        ok: true,
        reputations: registry.getAll().map((profile) => ({
          agentId: profile.agentId,
          reputation: reputationManager.getReputation(profile.agentId),
        })),
      };
    }

    case "world-phase-info":
      return { ok: true, phase: phaseManager.getState() };

    case "world-bet-place": {
      const a = args as { wallet: string; agentId: string; amount: number; txHash: string };
      if (!a?.wallet || !a?.agentId || !a?.txHash) {
        throw new Error("wallet, agentId, amount, and txHash required");
      }
      return placeVerifiedBet({
        wallet: a.wallet,
        agentId: a.agentId,
        amount: Number(a.amount),
        txHash: a.txHash,
      });
    }

    case "world-bets":
      return {
        ok: true,
        adminWallet: BET_WALLET_ADDRESS,
        currency: BET_TOKEN_SYMBOL,
        minBet: BET_MIN_AMOUNT,
        fixedAmount: BET_FIXED_AMOUNT,
        closed: bettingManager.isClosed(),
        totalPool: bettingManager.getTotalPool(),
        odds: bettingManager.getBetsPerAgent(),
        roundId: getCurrentRoundId(),
        neonEnabled: neonBetStore.enabled,
        rpcUrl: SOLANA_RPC_URL,
      };

    case "world-betting-report": {
      const a = args as { winnerAgentId?: string } | undefined;
      const winnerForReport = a?.winnerAgentId
        ?? lastPayoutReport?.winner
        ?? survivalState.winnerAgentId;
      const dbReport = winnerForReport ? await loadDbPayoutReport(winnerForReport) : null;
      if (a?.winnerAgentId) {
        return {
          ok: true,
          report: dbReport ?? bettingManager.generatePayoutReport(a.winnerAgentId),
          adminWallet: BET_WALLET_ADDRESS,
          roundId: getCurrentRoundId(),
          neonEnabled: neonBetStore.enabled,
        };
      }
      return {
        ok: true,
        report: dbReport ?? lastPayoutReport,
        adminWallet: BET_WALLET_ADDRESS,
        roundId: getCurrentRoundId(),
        neonEnabled: neonBetStore.enabled,
      };
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
        alliances: allianceManager.getAllAlliances(),
        phase: phaseManager.getState(),
        betting: {
          adminWallet: BET_WALLET_ADDRESS,
          currency: BET_TOKEN_SYMBOL,
          minBet: BET_MIN_AMOUNT,
          fixedAmount: BET_FIXED_AMOUNT,
          closed: bettingManager.isClosed(),
          totalPool: bettingManager.getTotalPool(),
          odds: bettingManager.getBetsPerAgent(),
          roundId: getCurrentRoundId(),
          neonEnabled: neonBetStore.enabled,
        },
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
  console.log(
    `[betting] wallet configured: ${BET_WALLET_ADDRESS ? "yes" : "no"} | min: ${BET_MIN_AMOUNT} ${BET_TOKEN_SYMBOL}`,
  );
  console.log(
    `[betting] Neon storage: ${neonBetStore.enabled ? "enabled" : "disabled"} | Solana verifier: ${solanaTransferService ? "enabled" : "disabled"}`,
  );

  if (neonBetStore.enabled) {
    await neonBetStore.init().catch((error) => {
      console.warn("[betting] Neon initialization warning:", error);
    });
  }
  if (neonEventStore.enabled) {
    await neonEventStore.init().catch((error) => {
      console.warn("[events] Neon event store initialization warning:", error);
    });
    console.log("[events] Neon event store: enabled");
  }

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

function gracefulShutdown(): void {
  console.log("\nShutting down...");
  gameLoop.stop();
  registry.flush();
  nostr.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
