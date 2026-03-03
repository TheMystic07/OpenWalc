import { neon } from "@neondatabase/serverless";
import type { GamePhase, SurvivalContractState, SurvivalStatus, SurvivalRoundSummary, Bet } from "./types.js";
import type { BettingRuntimeState } from "./betting-manager.js";

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
const MAX_RECENT_ROUNDS = 8;

const PHASE_VALUES = new Set<GamePhase>(["lobby", "battle", "showdown", "ended"]);

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
  updatedAt: number;
}

interface RuntimeStateRow {
  payload: string | RuntimeStateSnapshot;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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

function asFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
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
    if (
      !roundId ||
      settledAt === null ||
      !RESOLVED_SURVIVAL_STATUS_VALUES.has(statusRaw as SurvivalRoundSummary["status"])
    ) {
      continue;
    }
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    const prizePoolUsd = asFiniteNumber(record.prizePoolUsd) ?? 0;
    rounds.push({
      roundId,
      settledAt: Math.floor(settledAt),
      status: statusRaw as SurvivalRoundSummary["status"],
      winnerAgentIds: asStringArray(record.winnerAgentIds),
      winnerNames: asStringArray(record.winnerNames),
      summary,
      prizePoolUsd,
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
      const bettorWallet = typeof bet.bettorWallet === "string" ? bet.bettorWallet : "";
      const agentId = typeof bet.agentId === "string" ? bet.agentId : "";
      const txHash = typeof bet.txHash === "string" ? bet.txHash : "";
      const amount = asFiniteNumber(bet.amount);
      const placedAt = asFiniteNumber(bet.placedAt);
      if (!bettorWallet || !agentId || !txHash || amount === null || placedAt === null) continue;
      bets.push({ bettorWallet, agentId, txHash, amount, placedAt });
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
  const winnerAgentId = typeof record?.winnerAgentId === "string" ? record.winnerAgentId : undefined;
  const winnerAgentIds = asStringArray(record?.winnerAgentIds);
  const refusalAgentIds = asStringArray(record?.refusalAgentIds);
  const settledAt = asFiniteNumber(record?.settledAt) ?? undefined;
  const summary = typeof record?.summary === "string" ? record.summary : undefined;
  const roundDurationMs = asFiniteNumber(record?.roundDurationMs) ?? undefined;
  const roundOneDurationMs = asFiniteNumber(record?.roundOneDurationMs) ?? undefined;
  const roundTwoDurationMs = asFiniteNumber(record?.roundTwoDurationMs) ?? undefined;
  const finalRoundDurationMs = asFiniteNumber(record?.finalRoundDurationMs) ?? undefined;
  const roundStartedAt = asFiniteNumber(record?.roundStartedAt) ?? undefined;
  const roundEndsAt = asFiniteNumber(record?.roundEndsAt) ?? undefined;
  const recentRounds = normalizeRecentRounds(record?.recentRounds);

  return {
    status,
    prizePoolUsd,
    winnerAgentId,
    winnerAgentIds: winnerAgentIds.length > 0 ? winnerAgentIds : undefined,
    refusalAgentIds,
    settledAt,
    summary,
    roundOneDurationMs,
    roundTwoDurationMs,
    finalRoundDurationMs,
    roundDurationMs,
    roundStartedAt,
    roundEndsAt,
    recentRounds: recentRounds.length > 0 ? recentRounds : undefined,
  };
}

function normalizeSnapshot(roomId: string, value: unknown): RuntimeStateSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;

  const phaseRecord = asRecord(record.phase);
  const phaseString = typeof phaseRecord?.phase === "string" ? phaseRecord.phase : "lobby";
  const phase = PHASE_VALUES.has(phaseString as GamePhase) ? phaseString as GamePhase : "lobby";
  const startedAt = asFiniteNumber(phaseRecord?.startedAt) ?? 0;
  const roundNumberRaw = asFiniteNumber(phaseRecord?.roundNumber) ?? 0;
  const roundNumber = Math.max(0, Math.floor(roundNumberRaw));
  const safeZoneRadius = asFiniteNumber(phaseRecord?.safeZoneRadius) ?? 0;
  const lobbyMs = asFiniteNumber(phaseRecord?.lobbyMs) ?? undefined;
  const battleMs = asFiniteNumber(phaseRecord?.battleMs) ?? undefined;
  const showdownMs = asFiniteNumber(phaseRecord?.showdownMs) ?? undefined;

  const updatedAt = asFiniteNumber(record.updatedAt) ?? Date.now();
  const currentRoundId = typeof record.currentRoundId === "string" ? record.currentRoundId : "";

  return {
    roomId,
    currentRoundId,
    survival: normalizeSurvival(record.survival),
    phase: {
      phase,
      startedAt,
      roundNumber,
      safeZoneRadius,
      lobbyMs,
      battleMs,
      showdownMs,
    },
    participants: asStringArray(record.participants),
    alive: asStringArray(record.alive),
    bannedAgentIds: asStringArray(record.bannedAgentIds),
    betting: normalizeBetting(record.betting),
    updatedAt,
  };
}

export class NeonRuntimeStore {
  private readonly sql: ReturnType<typeof neon> | null;
  readonly enabled: boolean;

  constructor(databaseUrl = process.env.NEON_DATABASE_URL) {
    if (!databaseUrl) {
      this.sql = null;
      this.enabled = false;
      return;
    }
    this.sql = neon(databaseUrl);
    this.enabled = true;
  }

  async init(): Promise<void> {
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

  async load(roomId: string): Promise<RuntimeStateSnapshot | null> {
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
