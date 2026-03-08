import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { neon } from "@neondatabase/serverless";
import type { BettingRuntimeState } from "./betting-manager.js";
import type {
  AgentCombatState,
  AgentProfile,
  AgentSkillDeclaration,
  Alliance,
  BattleIntent,
  GamePhase,
  RuntimeBattleState,
  RuntimeIntentStreakState,
  RuntimeWorldAgentState,
  SurvivalContractState,
  SurvivalRoundSummary,
  SurvivalStatus,
  Bet,
} from "./types.js";

const SURVIVAL_STATUS_VALUES = new Set<SurvivalStatus>([
  "waiting",
  "active",
  "winner",
  "refused",
  "timer_ended",
]);
const RESOLVED_SURVIVAL_STATUS_VALUES = new Set<SurvivalRoundSummary["status"]>([
  "winner",
  "refused",
  "timer_ended",
]);
const PHASE_VALUES = new Set<GamePhase>(["lobby", "battle", "showdown", "ended"]);
const BATTLE_INTENT_VALUES = new Set<BattleIntent>(["approach", "strike", "guard", "feint", "retreat"]);
const MAX_RECENT_ROUNDS = 8;

export interface RuntimePhaseState {
  phase: GamePhase;
  startedAt: number;
  roundNumber: number;
  safeZoneRadius: number;
  lobbyMs?: number;
  battleMs?: number;
  showdownMs?: number;
}

export interface RuntimeStateSnapshot {
  roomId: string;
  currentRoundId: string;
  survival: SurvivalContractState;
  phase: RuntimePhaseState;
  participants: string[];
  alive: string[];
  bannedAgentIds: string[];
  betting: BettingRuntimeState;
  agents: RuntimeWorldAgentState[];
  alliances: Alliance[];
  battles: RuntimeBattleState[];
  updatedAt: number;
}

export interface RuntimeStateStoreOptions {
  databaseUrl?: string;
  localFilePath?: string;
}

interface RuntimeStateRow {
  payload: string | RuntimeStateSnapshot;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    result.push(trimmed);
  }
  return result;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = asFiniteNumber(value);
  if (parsed === null) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeRecentRounds(value: unknown): SurvivalRoundSummary[] {
  if (!Array.isArray(value)) return [];
  const rounds: SurvivalRoundSummary[] = [];
  for (const raw of value) {
    const record = asRecord(raw);
    if (!record) continue;
    const roundId = typeof record.roundId === "string" ? record.roundId.trim() : "";
    const settledAt = asFiniteNumber(record.settledAt);
    const statusRaw = typeof record.status === "string" ? record.status : "";
    if (!roundId || settledAt === null || !RESOLVED_SURVIVAL_STATUS_VALUES.has(statusRaw as SurvivalRoundSummary["status"])) {
      continue;
    }
    rounds.push({
      roundId,
      settledAt: Math.floor(settledAt),
      status: statusRaw as SurvivalRoundSummary["status"],
      winnerAgentIds: asStringArray(record.winnerAgentIds),
      winnerNames: asStringArray(record.winnerNames),
      summary: typeof record.summary === "string" ? record.summary.trim() : "",
      prizePoolUsd: asFiniteNumber(record.prizePoolUsd) ?? 0,
    });
  }
  rounds.sort((a, b) => b.settledAt - a.settledAt);
  return rounds.slice(0, MAX_RECENT_ROUNDS);
}

function normalizeBetting(value: unknown): BettingRuntimeState {
  const record = asRecord(value);
  const bets: Bet[] = [];
  if (Array.isArray(record?.bets)) {
    for (const raw of record.bets) {
      const bet = asRecord(raw);
      if (!bet) continue;
      const bettorWallet = typeof bet.bettorWallet === "string" ? bet.bettorWallet.trim() : "";
      const agentId = typeof bet.agentId === "string" ? bet.agentId.trim() : "";
      const txHash = typeof bet.txHash === "string" ? bet.txHash.trim() : "";
      const amount = asFiniteNumber(bet.amount);
      const placedAt = asFiniteNumber(bet.placedAt);
      if (!bettorWallet || !agentId || !txHash || amount === null || placedAt === null) continue;
      bets.push({
        bettorWallet,
        agentId,
        txHash,
        amount,
        placedAt: Math.floor(placedAt),
      });
    }
  }
  return {
    bets,
    closed: record?.closed === true,
  };
}

function normalizeSurvival(value: unknown): SurvivalContractState {
  const record = asRecord(value);
  const status = typeof record?.status === "string" && SURVIVAL_STATUS_VALUES.has(record.status as SurvivalStatus)
    ? record.status as SurvivalStatus
    : "waiting";
  const prizePoolUsd = asFiniteNumber(record?.prizePoolUsd) ?? 0;
  const roundDurationMs = asFiniteNumber(record?.roundDurationMs) ?? undefined;
  const roundStartedAt = asFiniteNumber(record?.roundStartedAt) ?? undefined;
  const roundEndsAt = asFiniteNumber(record?.roundEndsAt) ?? undefined;
  const recentRounds = normalizeRecentRounds(record?.recentRounds);

  return {
    status,
    prizePoolUsd,
    winnerAgentId: typeof record?.winnerAgentId === "string" ? record.winnerAgentId.trim() : undefined,
    winnerAgentIds: (() => {
      const ids = asStringArray(record?.winnerAgentIds);
      return ids.length > 0 ? ids : undefined;
    })(),
    refusalAgentIds: asStringArray(record?.refusalAgentIds),
    settledAt: asFiniteNumber(record?.settledAt) ?? undefined,
    summary: typeof record?.summary === "string" ? record.summary : undefined,
    roundOneDurationMs: asFiniteNumber(record?.roundOneDurationMs) ?? undefined,
    roundTwoDurationMs: asFiniteNumber(record?.roundTwoDurationMs) ?? undefined,
    finalRoundDurationMs: asFiniteNumber(record?.finalRoundDurationMs) ?? undefined,
    roundDurationMs,
    roundStartedAt,
    roundEndsAt,
    recentRounds: recentRounds.length > 0 ? recentRounds : undefined,
  };
}

function normalizeSkillDeclarations(value: unknown): AgentSkillDeclaration[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const skills: AgentSkillDeclaration[] = [];
  for (const rawSkill of value) {
    const record = asRecord(rawSkill);
    if (!record) continue;
    const skillId = typeof record.skillId === "string" ? record.skillId.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!skillId || !name) continue;
    skills.push({
      skillId,
      name,
      description: typeof record.description === "string" ? record.description.trim() : undefined,
    });
  }
  return skills.length > 0 ? skills : undefined;
}

function normalizeCombatState(value: unknown): AgentCombatState | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    wins: clampInt(record.wins, 0, 0, Number.MAX_SAFE_INTEGER),
    losses: clampInt(record.losses, 0, 0, Number.MAX_SAFE_INTEGER),
    kills: clampInt(record.kills, 0, 0, Number.MAX_SAFE_INTEGER),
    deaths: clampInt(record.deaths, 0, 0, Number.MAX_SAFE_INTEGER),
    guilt: clampInt(record.guilt, 0, 0, Number.MAX_SAFE_INTEGER),
    refusedPrize: record.refusedPrize === true,
    permanentlyDead: record.permanentlyDead === true,
    deathPermanentAt: asFiniteNumber(record.deathPermanentAt) ?? undefined,
    lastDeathAt: asFiniteNumber(record.lastDeathAt) ?? undefined,
    deadUntil: asFiniteNumber(record.deadUntil) ?? undefined,
  };
}

function normalizeAgentProfile(value: unknown): AgentProfile | null {
  const record = asRecord(value);
  if (!record) return null;

  const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
  if (!agentId) return null;

  const joinedAt = asFiniteNumber(record.joinedAt) ?? Date.now();
  const lastSeen = asFiniteNumber(record.lastSeen) ?? joinedAt;
  const combat = normalizeCombatState(record.combat);
  const skills = normalizeSkillDeclarations(record.skills);

  return {
    agentId,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : agentId,
    walletAddress: typeof record.walletAddress === "string" ? record.walletAddress.trim() : "",
    pubkey: typeof record.pubkey === "string" ? record.pubkey.trim() : "",
    bio: typeof record.bio === "string" ? record.bio : "",
    capabilities: asStringArray(record.capabilities),
    skills,
    combat,
    reputation: clampInt(record.reputation, 5, 0, 10),
    threatLevel: clampInt(record.threatLevel, 1, 1, 5),
    color: typeof record.color === "string" && record.color.trim() ? record.color.trim() : "#e74c3c",
    avatar: typeof record.avatar === "string" && record.avatar.trim() ? record.avatar.trim() : undefined,
    joinedAt: Math.floor(joinedAt),
    lastSeen: Math.floor(lastSeen),
  };
}

function normalizeWorldAgentState(value: unknown): RuntimeWorldAgentState | null {
  const record = asRecord(value);
  if (!record) return null;

  const profile = normalizeAgentProfile(record.profile);
  const positionRecord = asRecord(record.position);
  if (!profile || !positionRecord) return null;

  const x = asFiniteNumber(positionRecord.x);
  const y = asFiniteNumber(positionRecord.y);
  const z = asFiniteNumber(positionRecord.z);
  const rotation = asFiniteNumber(positionRecord.rotation);
  const timestamp = asFiniteNumber(positionRecord.timestamp);
  if (x === null || y === null || z === null || rotation === null || timestamp === null) return null;

  return {
    profile,
    position: {
      agentId: profile.agentId,
      x,
      y,
      z,
      rotation,
      timestamp: Math.floor(timestamp),
    },
    action: typeof record.action === "string" && record.action.trim() ? record.action.trim() : "idle",
  };
}

function normalizeWorldAgents(value: unknown): RuntimeWorldAgentState[] {
  if (!Array.isArray(value)) return [];
  const agents: RuntimeWorldAgentState[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const agent = normalizeWorldAgentState(raw);
    if (!agent || seen.has(agent.profile.agentId)) continue;
    seen.add(agent.profile.agentId);
    agents.push(agent);
  }
  agents.sort((a, b) => a.profile.agentId.localeCompare(b.profile.agentId));
  return agents;
}

function normalizeAlliance(value: unknown): Alliance | null {
  const record = asRecord(value);
  if (!record) return null;
  const allianceId = typeof record.allianceId === "string" ? record.allianceId.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const leader = typeof record.leader === "string" ? record.leader.trim() : "";
  const formedAt = asFiniteNumber(record.formedAt);
  const members = Array.from(new Set(asStringArray(record.members)));
  if (!allianceId || !name || !leader || formedAt === null || members.length < 2 || !members.includes(leader)) {
    return null;
  }
  return {
    allianceId,
    name,
    members,
    formedAt: Math.floor(formedAt),
    leader,
  };
}

function normalizeAlliances(value: unknown): Alliance[] {
  if (!Array.isArray(value)) return [];
  const alliances: Alliance[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const alliance = normalizeAlliance(raw);
    if (!alliance || seen.has(alliance.allianceId)) continue;
    seen.add(alliance.allianceId);
    alliances.push(alliance);
  }
  return alliances;
}

function normalizeIntentRecord(
  value: unknown,
  participants: [string, string],
): Partial<Record<string, BattleIntent>> {
  const record = asRecord(value);
  const intents: Partial<Record<string, BattleIntent>> = {};
  for (const participant of participants) {
    const candidate = record?.[participant];
    if (typeof candidate === "string" && BATTLE_INTENT_VALUES.has(candidate as BattleIntent)) {
      intents[participant] = candidate as BattleIntent;
    }
  }
  return intents;
}

function normalizeIntentStreakRecord(
  value: unknown,
  participants: [string, string],
): Record<string, RuntimeIntentStreakState> {
  const record = asRecord(value);
  const result: Record<string, RuntimeIntentStreakState> = {};
  for (const participant of participants) {
    const entry = asRecord(record?.[participant]);
    const intentRaw = typeof entry?.intent === "string" ? entry.intent : null;
    result[participant] = {
      intent: intentRaw && BATTLE_INTENT_VALUES.has(intentRaw as BattleIntent) ? intentRaw as BattleIntent : null,
      count: clampInt(entry?.count, 0, 0, Number.MAX_SAFE_INTEGER),
    };
  }
  return result;
}

function normalizeParticipantNumberRecord(
  value: unknown,
  participants: [string, string],
  fallback: number,
): Record<string, number> {
  const record = asRecord(value);
  const [a, b] = participants;
  return {
    [a]: asFiniteNumber(record?.[a]) ?? fallback,
    [b]: asFiniteNumber(record?.[b]) ?? fallback,
  };
}

function normalizeBattleState(value: unknown): RuntimeBattleState | null {
  const record = asRecord(value);
  if (!record) return null;

  const battleId = typeof record.battleId === "string" ? record.battleId.trim() : "";
  const participantIds = asStringArray(record.participants);
  if (!battleId || participantIds.length !== 2 || participantIds[0] === participantIds[1]) {
    return null;
  }
  const participants: [string, string] = [participantIds[0], participantIds[1]];

  return {
    battleId,
    participants,
    hp: normalizeParticipantNumberRecord(record.hp, participants, 100),
    power: normalizeParticipantNumberRecord(record.power, participants, 1),
    stamina: normalizeParticipantNumberRecord(record.stamina, participants, 100),
    intents: normalizeIntentRecord(record.intents, participants),
    intentStreak: normalizeIntentStreakRecord(record.intentStreak, participants),
    turn: clampInt(record.turn, 1, 1, Number.MAX_SAFE_INTEGER),
    startedAt: Math.max(0, Math.floor(asFiniteNumber(record.startedAt) ?? 0)),
    updatedAt: Math.max(0, Math.floor(asFiniteNumber(record.updatedAt) ?? 0)),
    turnStartedAt: Math.max(0, Math.floor(asFiniteNumber(record.turnStartedAt) ?? 0)),
    truceProposals: Array.from(new Set(
      asStringArray(record.truceProposals).filter((agentId) => participants.includes(agentId)),
    )),
  };
}

function normalizeBattles(value: unknown): RuntimeBattleState[] {
  if (!Array.isArray(value)) return [];
  const battles: RuntimeBattleState[] = [];
  const seenIds = new Set<string>();
  const busyAgents = new Set<string>();
  for (const raw of value) {
    const battle = normalizeBattleState(raw);
    if (!battle || seenIds.has(battle.battleId)) continue;
    if (battle.participants.some((agentId) => busyAgents.has(agentId))) continue;
    seenIds.add(battle.battleId);
    for (const agentId of battle.participants) busyAgents.add(agentId);
    battles.push(battle);
  }
  return battles;
}

function normalizeSnapshot(roomId: string, value: unknown): RuntimeStateSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;

  const phaseRecord = asRecord(record.phase);
  const phaseString = typeof phaseRecord?.phase === "string" ? phaseRecord.phase : "lobby";
  const phase = PHASE_VALUES.has(phaseString as GamePhase) ? phaseString as GamePhase : "lobby";

  return {
    roomId,
    currentRoundId: typeof record.currentRoundId === "string" ? record.currentRoundId.trim() : "",
    survival: normalizeSurvival(record.survival),
    phase: {
      phase,
      startedAt: Math.max(0, Math.floor(asFiniteNumber(phaseRecord?.startedAt) ?? 0)),
      roundNumber: clampInt(phaseRecord?.roundNumber, 0, 0, Number.MAX_SAFE_INTEGER),
      safeZoneRadius: asFiniteNumber(phaseRecord?.safeZoneRadius) ?? 0,
      lobbyMs: asFiniteNumber(phaseRecord?.lobbyMs) ?? undefined,
      battleMs: asFiniteNumber(phaseRecord?.battleMs) ?? undefined,
      showdownMs: asFiniteNumber(phaseRecord?.showdownMs) ?? undefined,
    },
    participants: asStringArray(record.participants),
    alive: asStringArray(record.alive),
    bannedAgentIds: asStringArray(record.bannedAgentIds),
    betting: normalizeBetting(record.betting),
    agents: normalizeWorldAgents(record.agents),
    alliances: normalizeAlliances(record.alliances),
    battles: normalizeBattles(record.battles),
    updatedAt: Math.max(0, Math.floor(asFiniteNumber(record.updatedAt) ?? Date.now())),
  };
}

function getDefaultLocalFilePath(): string {
  const configured = process.env.RUNTIME_STATE_FILE?.trim();
  return resolve(process.cwd(), configured || "output/runtime-state.json");
}

export class NeonRuntimeStore {
  private readonly sql: ReturnType<typeof neon> | null;
  private readonly localFilePath: string;
  readonly enabled: boolean;
  readonly mode: "local" | "local+neon";

  constructor(config: string | RuntimeStateStoreOptions = {}) {
    const resolvedConfig = typeof config === "string"
      ? { databaseUrl: config }
      : config;
    const databaseUrl = resolvedConfig.databaseUrl ?? process.env.NEON_DATABASE_URL;
    this.localFilePath = resolve(process.cwd(), resolvedConfig.localFilePath ?? getDefaultLocalFilePath());
    this.sql = databaseUrl ? neon(databaseUrl) : null;
    this.enabled = true;
    this.mode = this.sql ? "local+neon" : "local";
  }

  async init(): Promise<void> {
    mkdirSync(dirname(this.localFilePath), { recursive: true });
    if (!this.sql) return;

    await this.sql`
      CREATE TABLE IF NOT EXISTS openclaw_runtime_state (
        room_id TEXT PRIMARY KEY,
        payload JSONB NOT NULL DEFAULT '{}',
        updated_at BIGINT NOT NULL
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_openclaw_runtime_state_updated
      ON openclaw_runtime_state(updated_at DESC)
    `;
  }

  async save(snapshot: RuntimeStateSnapshot): Promise<void> {
    const errors: string[] = [];

    try {
      this.saveLocal(snapshot);
    } catch (error) {
      errors.push(`local:${error instanceof Error ? error.message : String(error)}`);
    }

    if (this.sql) {
      try {
        await this.saveNeon(snapshot);
      } catch (error) {
        errors.push(`neon:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length === 0) return;
    if (errors.length === 1 && !this.sql) {
      throw new Error(errors[0]);
    }
    if (errors.length >= (this.sql ? 2 : 1)) {
      throw new Error(`runtime snapshot persistence failed (${errors.join("; ")})`);
    }
    console.warn("[runtime] partial persistence warning:", errors.join("; "));
  }

  async load(roomId: string): Promise<RuntimeStateSnapshot | null> {
    const candidates: RuntimeStateSnapshot[] = [];
    const errors: string[] = [];

    try {
      const localSnapshot = this.loadLocal(roomId);
      if (localSnapshot) candidates.push(localSnapshot);
    } catch (error) {
      errors.push(`local:${error instanceof Error ? error.message : String(error)}`);
    }

    if (this.sql) {
      try {
        const neonSnapshot = await this.loadNeon(roomId);
        if (neonSnapshot) candidates.push(neonSnapshot);
      } catch (error) {
        errors.push(`neon:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (candidates.length === 0) {
      if (errors.length > 0 && errors.length >= (this.sql ? 2 : 1)) {
        throw new Error(`runtime snapshot load failed (${errors.join("; ")})`);
      }
      if (errors.length > 0) {
        console.warn("[runtime] partial load warning:", errors.join("; "));
      }
      return null;
    }

    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    if (errors.length > 0) {
      console.warn("[runtime] partial load warning:", errors.join("; "));
    }
    return candidates[0];
  }

  private saveLocal(snapshot: RuntimeStateSnapshot): void {
    mkdirSync(dirname(this.localFilePath), { recursive: true });
    writeFileSync(this.localFilePath, JSON.stringify(snapshot, null, 2), "utf-8");
  }

  private loadLocal(roomId: string): RuntimeStateSnapshot | null {
    if (!existsSync(this.localFilePath)) return null;
    const raw = readFileSync(this.localFilePath, "utf-8");
    if (!raw.trim()) return null;
    return normalizeSnapshot(roomId, JSON.parse(raw));
  }

  private async saveNeon(snapshot: RuntimeStateSnapshot): Promise<void> {
    if (!this.sql) return;
    await this.sql`
      INSERT INTO openclaw_runtime_state (room_id, payload, updated_at)
      VALUES (${snapshot.roomId}, ${JSON.stringify(snapshot)}::jsonb, ${snapshot.updatedAt})
      ON CONFLICT (room_id)
      DO UPDATE SET
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at
    `;
  }

  private async loadNeon(roomId: string): Promise<RuntimeStateSnapshot | null> {
    if (!this.sql) return null;
    const result = await this.sql`
      SELECT payload
      FROM openclaw_runtime_state
      WHERE room_id = ${roomId}
      LIMIT 1
    `;
    const rows = Array.isArray(result) ? (result as RuntimeStateRow[]) : [];
    if (rows.length === 0) return null;
    const rawPayload = rows[0].payload;
    const parsed = typeof rawPayload === "string"
      ? JSON.parse(rawPayload) as unknown
      : rawPayload;
    return normalizeSnapshot(roomId, parsed);
  }
}
