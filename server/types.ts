// Agent skill metadata attached to profiles.
export interface AgentSkillDeclaration {
  skillId: string;
  name: string;
  description?: string;
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

export interface AgentProfile {
  agentId: string;
  name: string;
  walletAddress: string;
  pubkey: string;
  bio: string;
  capabilities: string[];
  skills?: AgentSkillDeclaration[];
  combat?: AgentCombatState;
  // 0-10 social trust score. Starts at 5.
  reputation: number;
  // 1-5 danger score derived from kills.
  threatLevel: number;
  color: string;
  avatar?: string;
  joinedAt: number;
  lastSeen: number;
}

export interface AgentPosition {
  agentId: string;
  x: number;
  y: number;
  z: number;
  rotation: number;
  timestamp: number;
}

// Phase / weekly round control
export type GamePhase = "lobby" | "battle" | "showdown" | "ended";

export interface PhaseState {
  phase: GamePhase;
  startedAt: number;
  endsAt: number;
  roundNumber: number;
  safeZoneRadius: number;
  safeZoneCenter: { x: number; z: number };
}

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
  action: "walk" | "idle" | "wave" | "pinch" | "talk" | "dance" | "backflip" | "spin" | "eat" | "sit" | "swim" | "fly" | "roll" | "lay";
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
  // Optional explicit spawn. If omitted, server/world-state assigns one.
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
  // Message actor (required for relay validation)
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
  // Current stamina for each participant
  stamina?: Record<string, number>;
  // Momentum read-bonus damage applied this turn
  readBonus?: Record<string, number>;
  // Attackers that landed a critical hit this round.
  criticalHits?: string[];
  // Agents that were auto-guarded due to timeout
  timedOut?: string[];
  // Epoch ms deadline for the current or next turn state carried by this event
  turnDeadline?: number;
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
  // Current stamina for each participant
  stamina?: Record<string, number>;
  // Epoch ms deadline for the current turn
  turnDeadline?: number;
}

export interface RuntimeIntentStreakState {
  intent: BattleIntent | null;
  count: number;
}

export interface RuntimeBattleState {
  battleId: string;
  participants: [string, string];
  hp: Record<string, number>;
  power: Record<string, number>;
  stamina: Record<string, number>;
  intents: Partial<Record<string, BattleIntent>>;
  intentStreak: Record<string, RuntimeIntentStreakState>;
  turn: number;
  startedAt: number;
  updatedAt: number;
  turnStartedAt: number;
  truceProposals: string[];
}

export interface RuntimeWorldAgentState {
  profile: AgentProfile;
  position: AgentPosition;
  action: string;
}

export interface Alliance {
  allianceId: string;
  name: string;
  members: string[];
  formedAt: number;
  leader: string;
}

export interface AllianceProposal {
  proposalId: string;
  fromAgent: string;
  toAgent: string;
  expiresAt: number;
}

export interface ReputationRecord {
  agentId: string;
  score: number;
  betrayals: number;
  allianceDays: number;
}

export interface Territory {
  zoneId: string;
  ownerId: string | null;
  allianceId: string | null;
  claimStartedAt: number | null;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export interface Bet {
  bettorWallet: string;
  agentId: string;
  amount: number;
  txHash: string;
  placedAt: number;
}

export interface BetPayout {
  wallet: string;
  amount: number;
  agentId: string;
}

export function getThreatLevel(kills: number): number {
  if (kills >= 10) return 5;
  if (kills >= 7) return 4;
  if (kills >= 4) return 3;
  if (kills >= 2) return 2;
  return 1;
}

export type AllianceEventType =
  | "alliance_proposed"
  | "alliance_formed"
  | "alliance_broken"
  | "betrayal";

export interface AllianceMessage {
  worldType: "alliance";
  agentId: string;
  eventType: AllianceEventType;
  allianceId?: string;
  targetAgentId?: string;
  allianceName?: string;
  members?: string[];
  timestamp: number;
}

export interface PhaseMessage {
  worldType: "phase";
  agentId: string;
  phase: GamePhase;
  previousPhase: GamePhase;
  safeZoneRadius: number;
  endsAt: number;
  timestamp: number;
}

export interface WhisperMessage {
  worldType: "whisper";
  agentId: string;
  targetAgentId: string;
  text: string;
  timestamp: number;
}

export interface TerritoryMessage {
  worldType: "territory";
  zoneId: string;
  agentId: string;
  allianceId: string | null;
  eventType: "claimed" | "contested" | "lost";
  timestamp: number;
}

export interface BetMessage {
  worldType: "bet";
  agentId: string;
  bettorWallet: string;
  amount: number;
  totalPool: number;
  timestamp: number;
}

export interface ZoneDamageMessage {
  worldType: "zone_damage";
  agentId: string;
  damage: number;
  hp: number;
  timestamp: number;
}

export type WorldMessage =
  | PositionMessage
  | ActionMessage
  | EmoteMessage
  | ChatMessage
  | JoinMessage
  | LeaveMessage
  | ProfileMessage
  | BattleMessage
  | AllianceMessage
  | PhaseMessage
  | WhisperMessage
  | TerritoryMessage
  | BetMessage
  | ZoneDamageMessage;

export interface RoomInfoMessage {
  roomId: string;
  name: string;
  description: string;
  agents: number;
  maxAgents: number;
  nostrChannelId: string | null;
  survival: SurvivalContractState;
  phase: PhaseState;
}

export type SurvivalStatus = "waiting" | "active" | "winner" | "refused" | "timer_ended";

export interface SurvivalRoundSummary {
  roundId: string;
  settledAt: number;
  status: Exclude<SurvivalStatus, "waiting" | "active">;
  winnerAgentIds: string[];
  winnerNames: string[];
  summary: string;
  prizePoolUsd: number;
}

export interface SurvivalContractState {
  status: SurvivalStatus;
  prizePoolUsd: number;
  winnerAgentId?: string;
  winnerAgentIds?: string[];
  refusalAgentIds: string[];
  settledAt?: number;
  summary?: string;
  roundOneDurationMs?: number;
  roundTwoDurationMs?: number;
  finalRoundDurationMs?: number;
  roundDurationMs?: number;
  roundStartedAt?: number;
  roundEndsAt?: number;
  recentRounds?: SurvivalRoundSummary[];
}

export interface KillFeedEntry {
  type: "kill" | "betrayal" | "elimination" | "alliance_formed" | "alliance_broken";
  actorId?: string;
  targetId?: string;
  text: string;
  timestamp: number;
}

export interface LeaderboardEntry {
  agentId: string;
  name: string;
  kills: number;
  threatLevel: number;
  reputation: number;
  allianceName: string | null;
  alive: boolean;
}

export type WSServerMessage =
  | { type: "snapshot"; agents: AgentState[] }
  | { type: "world"; message: WorldMessage }
  | { type: "profiles"; profiles: AgentProfile[] }
  | { type: "profile"; profile: AgentProfile }
  | { type: "battleState"; battles: BattleStateSummary[] }
  | { type: "roomInfo"; info: RoomInfoMessage }
  | { type: "commandResult"; requestType: string; result: unknown }
  | { type: "phase"; state: PhaseState }
  | { type: "alliance"; alliances: Alliance[] }
  | { type: "territory"; territories: Territory[] }
  | { type: "bets"; bets: { agentId: string; totalBet: number; odds: number }[] }
  | { type: "killfeed"; entry: KillFeedEntry }
  | { type: "leaderboard"; entries: LeaderboardEntry[] };

export type WSClientMessage =
  | { type: "subscribe" }
  | { type: "requestProfiles" }
  | { type: "requestProfile"; agentId: string }
  | { type: "requestBattles" }
  | { type: "viewport"; x: number; z: number }
  | { type: "follow"; agentId: string }
  | { type: "requestRoomInfo" }
  | { type: "placeBet"; agentId: string; amount: number; txHash: string; wallet: string };

export interface AgentState {
  profile: AgentProfile;
  position: AgentPosition;
  action: string;
}

// Distance within which labels/bubbles are visible.
export const PROXIMITY_RADIUS = 60;

// Max distance between two agents to start a battle (face-to-face).
export const BATTLE_RANGE = 6;

// Max distance between two agents for chat/emote to be delivered.
export const CHAT_RANGE = 20;

// World bounds (300x300 island).
export const WORLD_SIZE = 300;
