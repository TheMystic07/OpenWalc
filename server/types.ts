// ── Agent Skill Declaration ────────────────────────────────────

export interface AgentSkillDeclaration {
  skillId: string;      // e.g. "code-review", "web-research"
  name: string;         // Human-readable
  description?: string; // What this agent does with this skill
}

export interface AgentCombatState {
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  guilt: number;
  refusedPrize: boolean;
  permanentlyDead: boolean;
  deathPermanentAt?: number;
  lastDeathAt?: number;
  deadUntil?: number;
}

// ── Agent Profile ──────────────────────────────────────────────

export interface AgentProfile {
  agentId: string;
  name: string;
  walletAddress: string;
  pubkey: string;
  bio: string;
  capabilities: string[];
  skills?: AgentSkillDeclaration[];
  combat?: AgentCombatState;
  color: string;
  avatar?: string;
  joinedAt: number;
  lastSeen: number;
}

// ── World Position ─────────────────────────────────────────────

export interface AgentPosition {
  agentId: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  timestamp: number;
}

// ── World Messages (kind 42 broadcast) ─────────────────────────

export type WorldMessage =
  | PositionMessage
  | ActionMessage
  | EmoteMessage
  | ChatMessage
  | JoinMessage
  | LeaveMessage
  | ProfileMessage
  | BattleMessage;

export interface PositionMessage {
  worldType: "position";
  agentId: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  timestamp: number;
}

export interface ActionMessage {
  worldType: "action";
  agentId: string;
  action: "walk" | "idle" | "wave" | "pinch" | "talk" | "dance" | "backflip" | "spin";
  targetAgentId?: string;
  timestamp: number;
}

export interface EmoteMessage {
  worldType: "emote";
  agentId: string;
  emote: "happy" | "thinking" | "surprised" | "laugh";
  timestamp: number;
}

export interface ChatMessage {
  worldType: "chat";
  agentId: string;
  text: string;
  timestamp: number;
}

export interface JoinMessage {
  worldType: "join";
  agentId: string;
  name: string;
  walletAddress: string;
  color: string;
  bio: string;
  capabilities: string[];
  skills?: AgentSkillDeclaration[];
  /** Optional explicit spawn. If omitted, server/world-state assigns one. */
  x?: number;
  y?: number;
  z?: number;
  rotation?: number;
  timestamp: number;
}

export interface LeaveMessage {
  worldType: "leave";
  agentId: string;
  timestamp: number;
}

export interface ProfileMessage {
  worldType: "profile";
  agentId: string;
  name: string;
  bio: string;
  capabilities: string[];
  color: string;
  timestamp: number;
}

export type BattleIntent = "approach" | "strike" | "guard" | "feint" | "retreat";
export type BattleEndReason = "ko" | "flee" | "surrender" | "disconnect" | "draw" | "truce";
export type BattlePhase = "started" | "intent" | "round" | "ended";

export interface BattleMessage {
  worldType: "battle";
  /** Message actor (required for relay validation) */
  agentId: string;
  battleId: string;
  phase: BattlePhase;
  participants: [string, string];
  turn: number;
  hp: Record<string, number>;
  damage?: Record<string, number>;
  summary: string;
  actorId?: string;
  intent?: BattleIntent;
  intents?: Partial<Record<string, BattleIntent>>;
  winnerId?: string;
  loserId?: string;
  defeatedIds?: string[];
  reason?: BattleEndReason;
  /** Current stamina for each participant */
  stamina?: Record<string, number>;
  /** Momentum read-bonus damage applied this turn */
  readBonus?: Record<string, number>;
  /** Agents that were auto-guarded due to timeout */
  timedOut?: string[];
  timestamp: number;
}

export interface BattleStateSummary {
  battleId: string;
  participants: [string, string];
  turn: number;
  hp: Record<string, number>;
  pending: string[];
  startedAt: number;
  updatedAt: number;
  /** Current stamina for each participant */
  stamina?: Record<string, number>;
  /** Epoch ms deadline for the current turn */
  turnDeadline?: number;
}

// ── Room info ─────────────────────────────────────────────────

export interface RoomInfoMessage {
  roomId: string;
  name: string;
  description: string;
  agents: number;
  maxAgents: number;
  nostrChannelId: string | null;
  survival: SurvivalContractState;
}

export type SurvivalStatus = "waiting" | "active" | "winner" | "refused" | "timer_ended";

export interface SurvivalContractState {
  status: SurvivalStatus;
  prizePoolUsd: number;
  winnerAgentId?: string;
  winnerAgentIds?: string[];
  refusalAgentIds: string[];
  settledAt?: number;
  summary?: string;
  roundDurationMs?: number;
  roundStartedAt?: number;
  roundEndsAt?: number;
}

// ── WebSocket messages (server ↔ browser) ──────────────────────

export type WSServerMessage =
  | { type: "snapshot"; agents: AgentState[] }
  | { type: "world"; message: WorldMessage }
  | { type: "profiles"; profiles: AgentProfile[] }
  | { type: "profile"; profile: AgentProfile }
  | { type: "battleState"; battles: BattleStateSummary[] }
  | { type: "roomInfo"; info: RoomInfoMessage };

export type WSClientMessage =
  | { type: "subscribe" }
  | { type: "requestProfiles" }
  | { type: "requestProfile"; agentId: string }
  | { type: "requestBattles" }
  | { type: "viewport"; x: number; z: number }
  | { type: "follow"; agentId: string }
  | { type: "requestRoomInfo" };

// ── Combined agent state for snapshot ──────────────────────────

export interface AgentState {
  profile: AgentProfile;
  position: AgentPosition;
  action: string;
}

// ── Proximity constants ────────────────────────────────────────

/** Distance within which labels/bubbles are visible */
export const PROXIMITY_RADIUS = 60;

/** Max distance between two agents to start a battle (face-to-face) */
export const BATTLE_RANGE = 6;

/** Max distance between two agents for chat/emote to be delivered */
export const CHAT_RANGE = 20;

/** World bounds (300×300 island) */
export const WORLD_SIZE = 300;
