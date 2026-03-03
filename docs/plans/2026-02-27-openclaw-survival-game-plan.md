# OpenClaw Weekly Survival Game — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform OpenClaw World into a weekly AI agent survival game with phased rounds, diplomacy, enhanced combat visuals, broadcast spectator experience, and betting.

**Architecture:** Full WebSocket architecture. Agents and spectators connect via WS, server pushes events. Phased weekly rounds (Lobby → Battle → Showdown → Ended) with automatic transitions. Alliance/diplomacy system with reputation. Enhanced battle visuals using existing animation functions. Broadcast-style spectator UI with auto-camera, kill feed, minimap.

**Tech Stack:** Node.js + ws (server), Three.js + CSS2DRenderer (frontend), Vite (build), Vitest (tests), TypeScript strict mode.

**Design Doc:** `docs/plans/2026-02-27-openclaw-survival-game-design.md`

---

## Phase 1: Server Foundation (Types, Phase Manager, Alliance Manager)

### Task 1: Extend Types for New Systems

**Files:**
- Modify: `server/types.ts` (239 lines)

**Step 1: Add new type definitions**

Add these types to `server/types.ts` after the existing types:

```typescript
// === PHASE SYSTEM ===
export type GamePhase = "lobby" | "battle" | "showdown" | "ended";

export interface PhaseState {
  phase: GamePhase;
  startedAt: number;
  endsAt: number;
  roundNumber: number;
  safeZoneRadius: number;
  safeZoneCenter: { x: number; z: number };
}

// === ALLIANCE SYSTEM ===
export interface Alliance {
  allianceId: string;
  name: string;
  members: string[];        // agentIds
  formedAt: number;
  leader: string;           // agentId who proposed
}

export interface AllianceProposal {
  proposalId: string;
  fromAgent: string;
  toAgent: string;
  expiresAt: number;
}

// === REPUTATION ===
export interface ReputationRecord {
  agentId: string;
  score: number;            // 0-10, starts at 5
  betrayals: number;
  allianceDays: number;
}

// === TERRITORY ===
export interface Territory {
  zoneId: string;           // "0-0" to "2-2"
  ownerId: string | null;   // agentId or null
  allianceId: string | null;
  claimStartedAt: number | null;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

// === BETTING ===
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

// === THREAT LEVEL ===
export function getThreatLevel(kills: number): number {
  if (kills >= 10) return 5;
  if (kills >= 7) return 4;
  if (kills >= 4) return 3;
  if (kills >= 2) return 2;
  return 1;
}

// === NEW EVENT TYPES ===
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
  bettorWallet: string;
  agentId: string;
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

// Extend WorldMessage union
// Update the WorldMessage type to include new message types:
// export type WorldMessage = PositionMessage | ActionMessage | EmoteMessage | ChatMessage
//   | JoinMessage | LeaveMessage | ProfileMessage | BattleMessage
//   | AllianceMessage | PhaseMessage | WhisperMessage | TerritoryMessage
//   | BetMessage | ZoneDamageMessage;

// === EXTENDED WS MESSAGES ===
// Add to WSServerMessage union:
// | { type: "phase"; state: PhaseState }
// | { type: "alliance"; alliances: Alliance[] }
// | { type: "territory"; territories: Territory[] }
// | { type: "bets"; bets: { agentId: string; totalBet: number; odds: number }[] }
// | { type: "killfeed"; entry: KillFeedEntry }
// | { type: "leaderboard"; entries: LeaderboardEntry[] }

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

// Add to WSClientMessage union for spectators:
// | { type: "placeBet"; agentId: string; amount: number; txHash: string; wallet: string }

// Add to AgentProfile:
// reputation: number;        // 0-10
// threatLevel: number;       // 1-5
```

**Step 2: Run type check**

Run: `npx tsc --noEmit -p tsconfig.server.json`
Expected: PASS (new types are additive, no breaking changes)

**Step 3: Commit**

```bash
git add server/types.ts
git commit -m "feat: add types for phases, alliances, reputation, territory, betting"
```

---

### Task 2: Create Phase Manager

**Files:**
- Create: `server/phase-manager.ts`
- Test: `server/__tests__/phase-manager.test.ts`

**Step 1: Write failing tests**

```typescript
// server/__tests__/phase-manager.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PhaseManager } from "../phase-manager.js";

describe("PhaseManager", () => {
  let pm: PhaseManager;

  beforeEach(() => {
    pm = new PhaseManager({
      lobbyHours: 48,
      battleHours: 72,
      showdownHours: 48,
      zoneShrinkIntervalHours: 4,
      zoneFinalRadius: 30,
      worldRadius: 150,
    });
  });

  it("starts in lobby phase", () => {
    expect(pm.getPhase()).toBe("lobby");
  });

  it("transitions lobby -> battle after lobbyHours", () => {
    const events: string[] = [];
    pm.onPhaseChange((phase) => events.push(phase));
    pm.startRound(Date.now());
    // Simulate time passing
    pm.tick(Date.now() + 48 * 60 * 60 * 1000 + 1);
    expect(pm.getPhase()).toBe("battle");
    expect(events).toContain("battle");
  });

  it("transitions battle -> showdown", () => {
    pm.startRound(Date.now());
    const battleStart = Date.now() + 48 * 60 * 60 * 1000 + 1;
    pm.tick(battleStart);
    pm.tick(battleStart + 72 * 60 * 60 * 1000 + 1);
    expect(pm.getPhase()).toBe("showdown");
  });

  it("shrinks safe zone during showdown", () => {
    pm.startRound(Date.now());
    const showdownStart = Date.now() + (48 + 72) * 60 * 60 * 1000 + 1;
    pm.tick(showdownStart);
    expect(pm.getPhase()).toBe("showdown");
    expect(pm.getSafeZoneRadius()).toBe(150); // full at start
    pm.tick(showdownStart + 4 * 60 * 60 * 1000); // 4 hours later
    expect(pm.getSafeZoneRadius()).toBeLessThan(150);
  });

  it("rejects combat commands in lobby", () => {
    pm.startRound(Date.now());
    expect(pm.isCombatAllowed()).toBe(false);
  });

  it("allows combat in battle phase", () => {
    pm.startRound(Date.now());
    pm.tick(Date.now() + 48 * 60 * 60 * 1000 + 1);
    expect(pm.isCombatAllowed()).toBe(true);
  });

  it("returns correct phase state", () => {
    pm.startRound(Date.now());
    const state = pm.getState();
    expect(state.phase).toBe("lobby");
    expect(state.roundNumber).toBe(1);
    expect(state.safeZoneRadius).toBe(150);
  });

  it("ends round", () => {
    pm.startRound(Date.now());
    pm.endRound("agent-1");
    expect(pm.getPhase()).toBe("ended");
  });

  it("resets for new round", () => {
    pm.startRound(Date.now());
    pm.endRound("agent-1");
    pm.reset();
    expect(pm.getPhase()).toBe("lobby");
  });

  it("getAllianceMaxSize returns 4 in battle, 2 in showdown", () => {
    pm.startRound(Date.now());
    pm.tick(Date.now() + 48 * 60 * 60 * 1000 + 1); // battle
    expect(pm.getAllianceMaxSize()).toBe(4);
    pm.tick(Date.now() + (48 + 72) * 60 * 60 * 1000 + 1); // showdown
    expect(pm.getAllianceMaxSize()).toBe(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run server/__tests__/phase-manager.test.ts`
Expected: FAIL — module not found

**Step 3: Implement PhaseManager**

```typescript
// server/phase-manager.ts
import type { GamePhase, PhaseState } from "./types.js";

interface PhaseConfig {
  lobbyHours: number;
  battleHours: number;
  showdownHours: number;
  zoneShrinkIntervalHours: number;
  zoneFinalRadius: number;
  worldRadius: number;
}

const HOUR_MS = 60 * 60 * 1000;

export class PhaseManager {
  private phase: GamePhase = "lobby";
  private roundStartedAt = 0;
  private roundNumber = 0;
  private safeZoneRadius: number;
  private winnerId: string | null = null;
  private listeners: ((phase: GamePhase, prev: GamePhase) => void)[] = [];

  constructor(private config: PhaseConfig) {
    this.safeZoneRadius = config.worldRadius;
  }

  getPhase(): GamePhase { return this.phase; }
  getSafeZoneRadius(): number { return this.safeZoneRadius; }
  getRoundNumber(): number { return this.roundNumber; }

  getState(): PhaseState {
    return {
      phase: this.phase,
      startedAt: this.roundStartedAt,
      endsAt: this.getPhaseEndsAt(),
      roundNumber: this.roundNumber,
      safeZoneRadius: this.safeZoneRadius,
      safeZoneCenter: { x: 0, z: 0 },
    };
  }

  onPhaseChange(listener: (phase: GamePhase, prev: GamePhase) => void): void {
    this.listeners.push(listener);
  }

  startRound(now: number): void {
    this.roundStartedAt = now;
    this.roundNumber++;
    this.phase = "lobby";
    this.safeZoneRadius = this.config.worldRadius;
    this.winnerId = null;
  }

  endRound(winnerId: string | null): void {
    this.winnerId = winnerId;
    this.setPhase("ended");
  }

  reset(): void {
    this.phase = "lobby";
    this.safeZoneRadius = this.config.worldRadius;
    this.winnerId = null;
    this.roundStartedAt = 0;
  }

  isCombatAllowed(): boolean {
    return this.phase === "battle" || this.phase === "showdown";
  }

  getAllianceMaxSize(): number {
    if (this.phase === "showdown") return 2;
    return 4;
  }

  isAutoAcceptChallenge(): boolean {
    return this.phase === "showdown";
  }

  tick(now: number): void {
    if (this.phase === "ended" || this.roundStartedAt === 0) return;

    const elapsed = now - this.roundStartedAt;
    const lobbyEnd = this.config.lobbyHours * HOUR_MS;
    const battleEnd = lobbyEnd + this.config.battleHours * HOUR_MS;
    const showdownEnd = battleEnd + this.config.showdownHours * HOUR_MS;

    if (this.phase === "lobby" && elapsed >= lobbyEnd) {
      this.setPhase("battle");
    } else if (this.phase === "battle" && elapsed >= battleEnd) {
      this.setPhase("showdown");
    } else if (this.phase === "showdown" && elapsed >= showdownEnd) {
      this.endRound(null); // timer expired
    }

    // Shrink zone during showdown
    if (this.phase === "showdown") {
      const showdownElapsed = elapsed - battleEnd;
      const shrinkInterval = this.config.zoneShrinkIntervalHours * HOUR_MS;
      const shrinkSteps = Math.floor(showdownElapsed / shrinkInterval);
      const totalSteps = Math.ceil(this.config.showdownHours / this.config.zoneShrinkIntervalHours);
      const radiusRange = this.config.worldRadius - this.config.zoneFinalRadius;
      this.safeZoneRadius = Math.max(
        this.config.zoneFinalRadius,
        this.config.worldRadius - (radiusRange * shrinkSteps / totalSteps)
      );
    }
  }

  private getPhaseEndsAt(): number {
    if (this.roundStartedAt === 0) return 0;
    const lobbyEnd = this.config.lobbyHours * HOUR_MS;
    const battleEnd = lobbyEnd + this.config.battleHours * HOUR_MS;
    const showdownEnd = battleEnd + this.config.showdownHours * HOUR_MS;
    switch (this.phase) {
      case "lobby": return this.roundStartedAt + lobbyEnd;
      case "battle": return this.roundStartedAt + battleEnd;
      case "showdown": return this.roundStartedAt + showdownEnd;
      default: return 0;
    }
  }

  private setPhase(next: GamePhase): void {
    const prev = this.phase;
    if (prev === next) return;
    this.phase = next;
    for (const fn of this.listeners) fn(next, prev);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run server/__tests__/phase-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/phase-manager.ts server/__tests__/phase-manager.test.ts
git commit -m "feat: add PhaseManager with automatic phase transitions and zone shrinking"
```

---

### Task 3: Create Alliance Manager

**Files:**
- Create: `server/alliance-manager.ts`
- Test: `server/__tests__/alliance-manager.test.ts`

**Step 1: Write failing tests**

```typescript
// server/__tests__/alliance-manager.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { AllianceManager } from "../alliance-manager.js";

describe("AllianceManager", () => {
  let am: AllianceManager;

  beforeEach(() => {
    am = new AllianceManager();
  });

  it("proposes alliance", () => {
    const result = am.propose("agent-1", "agent-2");
    expect(result.ok).toBe(true);
  });

  it("accepts alliance proposal", () => {
    am.propose("agent-1", "agent-2");
    const result = am.accept("agent-2", "agent-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alliance.members).toContain("agent-1");
      expect(result.alliance.members).toContain("agent-2");
    }
  });

  it("declines alliance proposal", () => {
    am.propose("agent-1", "agent-2");
    const result = am.decline("agent-2", "agent-1");
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate proposals", () => {
    am.propose("agent-1", "agent-2");
    const result = am.propose("agent-1", "agent-2");
    expect(result.ok).toBe(false);
  });

  it("prevents alliance with self", () => {
    const result = am.propose("agent-1", "agent-1");
    expect(result.ok).toBe(false);
  });

  it("breaks alliance", () => {
    am.propose("agent-1", "agent-2");
    am.accept("agent-2", "agent-1");
    const result = am.breakAlliance("agent-1");
    expect(result.ok).toBe(true);
    expect(am.getAlliance("agent-1")).toBeNull();
  });

  it("detects betrayal when breaking alliance", () => {
    am.propose("agent-1", "agent-2");
    am.accept("agent-2", "agent-1");
    const result = am.breakAlliance("agent-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.betrayal).toBe(true);
      expect(result.formerAllies).toContain("agent-2");
    }
  });

  it("checks if two agents are allies", () => {
    am.propose("agent-1", "agent-2");
    am.accept("agent-2", "agent-1");
    expect(am.areAllies("agent-1", "agent-2")).toBe(true);
    expect(am.areAllies("agent-1", "agent-3")).toBe(false);
  });

  it("enforces max alliance size", () => {
    am.setMaxSize(2);
    am.propose("agent-1", "agent-2");
    am.accept("agent-2", "agent-1");
    // agent-3 tries to join agent-1's alliance
    am.propose("agent-1", "agent-3");
    const result = am.accept("agent-3", "agent-1");
    expect(result.ok).toBe(false);
  });

  it("expires proposals after timeout", () => {
    am.propose("agent-1", "agent-2", Date.now() - 31000);
    am.expireProposals(Date.now());
    const result = am.accept("agent-2", "agent-1");
    expect(result.ok).toBe(false);
  });

  it("removes agent from alliance on leave", () => {
    am.propose("agent-1", "agent-2");
    am.accept("agent-2", "agent-1");
    am.removeAgent("agent-1");
    expect(am.getAlliance("agent-1")).toBeNull();
    expect(am.getAlliance("agent-2")).toBeNull(); // alliance dissolves with <2 members
  });

  it("returns all alliances", () => {
    am.propose("a1", "a2");
    am.accept("a2", "a1");
    am.propose("a3", "a4");
    am.accept("a4", "a3");
    expect(am.getAllAlliances()).toHaveLength(2);
  });

  it("blocks alliance for agents with guilt > 5 (ruthless)", () => {
    const result = am.propose("agent-1", "agent-2", Date.now(), 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ruthless");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run server/__tests__/alliance-manager.test.ts`
Expected: FAIL

**Step 3: Implement AllianceManager**

```typescript
// server/alliance-manager.ts
import type { Alliance, AllianceProposal } from "./types.js";

const PROPOSAL_TIMEOUT_MS = 30_000;

interface ProposalResult {
  ok: true;
  proposalId: string;
} | {
  ok: false;
  error: string;
}

interface AcceptResult {
  ok: true;
  alliance: Alliance;
} | {
  ok: false;
  error: string;
}

interface BreakResult {
  ok: true;
  betrayal: boolean;
  formerAllies: string[];
  allianceId: string;
} | {
  ok: false;
  error: string;
}

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}-${nextId++}`;
}

export class AllianceManager {
  private alliances = new Map<string, Alliance>();           // allianceId -> Alliance
  private agentAlliance = new Map<string, string>();         // agentId -> allianceId
  private proposals = new Map<string, AllianceProposal>();   // proposalId -> Proposal
  private maxSize = 4;

  setMaxSize(size: number): void {
    this.maxSize = size;
  }

  propose(fromAgent: string, toAgent: string, now = Date.now(), fromGuilt = 0): ProposalResult {
    if (fromAgent === toAgent) return { ok: false, error: "Cannot ally with self" };
    if (fromGuilt > 5) return { ok: false, error: "Agent is ruthless (guilt > 5), cannot propose alliances" };

    // Check for existing proposal
    for (const p of this.proposals.values()) {
      if (p.fromAgent === fromAgent && p.toAgent === toAgent) {
        return { ok: false, error: "Proposal already pending" };
      }
    }

    // Check if from-agent's alliance is full
    const fromAllianceId = this.agentAlliance.get(fromAgent);
    if (fromAllianceId) {
      const alliance = this.alliances.get(fromAllianceId);
      if (alliance && alliance.members.length >= this.maxSize) {
        return { ok: false, error: "Alliance is full" };
      }
    }

    const proposalId = genId("prop");
    this.proposals.set(proposalId, {
      proposalId,
      fromAgent,
      toAgent,
      expiresAt: now + PROPOSAL_TIMEOUT_MS,
    });

    return { ok: true, proposalId };
  }

  accept(acceptingAgent: string, proposingAgent: string): AcceptResult {
    // Find matching proposal
    let proposal: AllianceProposal | null = null;
    for (const p of this.proposals.values()) {
      if (p.fromAgent === proposingAgent && p.toAgent === acceptingAgent) {
        proposal = p;
        break;
      }
    }
    if (!proposal) return { ok: false, error: "No pending proposal found" };

    this.proposals.delete(proposal.proposalId);

    // Check if accepting agent already in an alliance
    if (this.agentAlliance.has(acceptingAgent)) {
      return { ok: false, error: "Already in an alliance" };
    }

    // Join proposer's alliance or create new one
    const existingAllianceId = this.agentAlliance.get(proposingAgent);
    if (existingAllianceId) {
      const alliance = this.alliances.get(existingAllianceId)!;
      if (alliance.members.length >= this.maxSize) {
        return { ok: false, error: "Alliance is full" };
      }
      alliance.members.push(acceptingAgent);
      this.agentAlliance.set(acceptingAgent, existingAllianceId);
      return { ok: true, alliance: { ...alliance } };
    }

    // Create new alliance
    const allianceId = genId("ally");
    const alliance: Alliance = {
      allianceId,
      name: `Alliance ${allianceId}`,
      members: [proposingAgent, acceptingAgent],
      formedAt: Date.now(),
      leader: proposingAgent,
    };
    this.alliances.set(allianceId, alliance);
    this.agentAlliance.set(proposingAgent, allianceId);
    this.agentAlliance.set(acceptingAgent, allianceId);

    return { ok: true, alliance: { ...alliance } };
  }

  decline(decliningAgent: string, proposingAgent: string): { ok: boolean } {
    for (const [id, p] of this.proposals.entries()) {
      if (p.fromAgent === proposingAgent && p.toAgent === decliningAgent) {
        this.proposals.delete(id);
        return { ok: true };
      }
    }
    return { ok: false };
  }

  breakAlliance(agentId: string): BreakResult {
    const allianceId = this.agentAlliance.get(agentId);
    if (!allianceId) return { ok: false, error: "Not in an alliance" };

    const alliance = this.alliances.get(allianceId);
    if (!alliance) return { ok: false, error: "Alliance not found" };

    const formerAllies = alliance.members.filter(id => id !== agentId);

    // Remove agent
    alliance.members = alliance.members.filter(id => id !== agentId);
    this.agentAlliance.delete(agentId);

    // Dissolve if < 2 members
    if (alliance.members.length < 2) {
      for (const m of alliance.members) this.agentAlliance.delete(m);
      this.alliances.delete(allianceId);
    }

    return { ok: true, betrayal: true, formerAllies, allianceId };
  }

  areAllies(a: string, b: string): boolean {
    const allianceA = this.agentAlliance.get(a);
    const allianceB = this.agentAlliance.get(b);
    return allianceA !== undefined && allianceA === allianceB;
  }

  getAlliance(agentId: string): Alliance | null {
    const id = this.agentAlliance.get(agentId);
    if (!id) return null;
    return this.alliances.get(id) ?? null;
  }

  getAllAlliances(): Alliance[] {
    return Array.from(this.alliances.values());
  }

  removeAgent(agentId: string): void {
    const allianceId = this.agentAlliance.get(agentId);
    if (!allianceId) return;

    const alliance = this.alliances.get(allianceId);
    if (!alliance) return;

    alliance.members = alliance.members.filter(id => id !== agentId);
    this.agentAlliance.delete(agentId);

    if (alliance.members.length < 2) {
      for (const m of alliance.members) this.agentAlliance.delete(m);
      this.alliances.delete(allianceId);
    }
  }

  expireProposals(now: number): string[] {
    const expired: string[] = [];
    for (const [id, p] of this.proposals.entries()) {
      if (now >= p.expiresAt) {
        this.proposals.delete(id);
        expired.push(id);
      }
    }
    return expired;
  }

  // Dissolve alliances larger than maxSize (for phase transitions)
  enforceMaxSize(): { dissolved: Alliance[]; kept: Alliance[] } {
    const dissolved: Alliance[] = [];
    const kept: Alliance[] = [];
    for (const alliance of this.alliances.values()) {
      if (alliance.members.length > this.maxSize) {
        dissolved.push({ ...alliance });
        // Keep only first maxSize members
        const removed = alliance.members.splice(this.maxSize);
        for (const m of removed) this.agentAlliance.delete(m);
        if (alliance.members.length < 2) {
          for (const m of alliance.members) this.agentAlliance.delete(m);
          this.alliances.delete(alliance.allianceId);
        }
      } else {
        kept.push({ ...alliance });
      }
    }
    return { dissolved, kept };
  }

  reset(): void {
    this.alliances.clear();
    this.agentAlliance.clear();
    this.proposals.clear();
    this.maxSize = 4;
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run server/__tests__/alliance-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/alliance-manager.ts server/__tests__/alliance-manager.test.ts
git commit -m "feat: add AllianceManager with proposals, betrayal detection, max size enforcement"
```

---

### Task 4: Create Betting Manager

**Files:**
- Create: `server/betting-manager.ts`
- Test: `server/__tests__/betting-manager.test.ts`

**Step 1: Write failing tests**

```typescript
// server/__tests__/betting-manager.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { BettingManager } from "../betting-manager.js";

describe("BettingManager", () => {
  let bm: BettingManager;

  beforeEach(() => {
    bm = new BettingManager({ minBet: 1, walletAddress: "admin-wallet-123" });
  });

  it("places a bet", () => {
    const result = bm.placeBet("wallet-a", "agent-1", 10, "tx-hash-1");
    expect(result.ok).toBe(true);
  });

  it("rejects bet below minimum", () => {
    const result = bm.placeBet("wallet-a", "agent-1", 0.5, "tx-hash-1");
    expect(result.ok).toBe(false);
  });

  it("calculates odds", () => {
    bm.placeBet("wallet-a", "agent-1", 100, "tx-1");
    bm.placeBet("wallet-b", "agent-2", 50, "tx-2");
    const odds = bm.getOdds();
    expect(odds.get("agent-1")).toBeCloseTo(1.5, 1); // 150/100
    expect(odds.get("agent-2")).toBeCloseTo(3.0, 1); // 150/50
  });

  it("calculates payouts for winning agent", () => {
    bm.placeBet("wallet-a", "agent-1", 100, "tx-1");
    bm.placeBet("wallet-b", "agent-1", 50, "tx-2");
    bm.placeBet("wallet-c", "agent-2", 200, "tx-3");
    const payouts = bm.resolve("agent-1");
    // Pool = 350. wallet-a bet 100/150 of agent-1 bets, wallet-b bet 50/150
    expect(payouts).toHaveLength(2);
    const payoutA = payouts.find(p => p.wallet === "wallet-a")!;
    const payoutB = payouts.find(p => p.wallet === "wallet-b")!;
    expect(payoutA.amount).toBeCloseTo(233.33, 1); // 100/150 * 350
    expect(payoutB.amount).toBeCloseTo(116.67, 1); // 50/150 * 350
  });

  it("returns empty payouts if nobody bet on winner", () => {
    bm.placeBet("wallet-a", "agent-1", 100, "tx-1");
    const payouts = bm.resolve("agent-2");
    expect(payouts).toHaveLength(0);
  });

  it("returns total pool size", () => {
    bm.placeBet("wallet-a", "agent-1", 100, "tx-1");
    bm.placeBet("wallet-b", "agent-2", 50, "tx-2");
    expect(bm.getTotalPool()).toBe(150);
  });

  it("closes betting", () => {
    bm.closeBetting();
    const result = bm.placeBet("wallet-a", "agent-1", 100, "tx-1");
    expect(result.ok).toBe(false);
  });

  it("resets for new round", () => {
    bm.placeBet("wallet-a", "agent-1", 100, "tx-1");
    bm.reset();
    expect(bm.getTotalPool()).toBe(0);
  });

  it("returns admin wallet address", () => {
    expect(bm.getWalletAddress()).toBe("admin-wallet-123");
  });

  it("generates payout report", () => {
    bm.placeBet("wallet-a", "agent-1", 100, "tx-1");
    bm.placeBet("wallet-b", "agent-2", 50, "tx-2");
    const report = bm.generatePayoutReport("agent-1");
    expect(report.winner).toBe("agent-1");
    expect(report.totalPool).toBe(150);
    expect(report.payouts).toHaveLength(1);
    expect(report.payouts[0].wallet).toBe("wallet-a");
    expect(report.payouts[0].amount).toBe(150);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run server/__tests__/betting-manager.test.ts`
Expected: FAIL

**Step 3: Implement BettingManager**

```typescript
// server/betting-manager.ts
import type { Bet, BetPayout } from "./types.js";

interface BettingConfig {
  minBet: number;
  walletAddress: string;
}

interface BetResult {
  ok: true;
  bet: Bet;
} | {
  ok: false;
  error: string;
}

interface PayoutReport {
  winner: string;
  totalPool: number;
  payouts: BetPayout[];
  generatedAt: number;
}

export class BettingManager {
  private bets: Bet[] = [];
  private closed = false;

  constructor(private config: BettingConfig) {}

  placeBet(bettorWallet: string, agentId: string, amount: number, txHash: string): BetResult {
    if (this.closed) return { ok: false, error: "Betting is closed" };
    if (amount < this.config.minBet) {
      return { ok: false, error: `Minimum bet is ${this.config.minBet}` };
    }

    const bet: Bet = { bettorWallet, agentId, amount, txHash, placedAt: Date.now() };
    this.bets.push(bet);
    return { ok: true, bet };
  }

  getOdds(): Map<string, number> {
    const pool = this.getTotalPool();
    if (pool === 0) return new Map();

    const perAgent = new Map<string, number>();
    for (const bet of this.bets) {
      perAgent.set(bet.agentId, (perAgent.get(bet.agentId) ?? 0) + bet.amount);
    }

    const odds = new Map<string, number>();
    for (const [agentId, total] of perAgent) {
      odds.set(agentId, pool / total);
    }
    return odds;
  }

  getBetsPerAgent(): { agentId: string; totalBet: number; odds: number }[] {
    const pool = this.getTotalPool();
    const perAgent = new Map<string, number>();
    for (const bet of this.bets) {
      perAgent.set(bet.agentId, (perAgent.get(bet.agentId) ?? 0) + bet.amount);
    }
    return Array.from(perAgent.entries()).map(([agentId, totalBet]) => ({
      agentId,
      totalBet,
      odds: pool > 0 ? pool / totalBet : 0,
    }));
  }

  resolve(winnerId: string): BetPayout[] {
    const winnerBets = this.bets.filter(b => b.agentId === winnerId);
    if (winnerBets.length === 0) return [];

    const pool = this.getTotalPool();
    const winnerTotal = winnerBets.reduce((sum, b) => sum + b.amount, 0);

    return winnerBets.map(b => ({
      wallet: b.bettorWallet,
      amount: (b.amount / winnerTotal) * pool,
      agentId: winnerId,
    }));
  }

  generatePayoutReport(winnerId: string): PayoutReport {
    return {
      winner: winnerId,
      totalPool: this.getTotalPool(),
      payouts: this.resolve(winnerId),
      generatedAt: Date.now(),
    };
  }

  getTotalPool(): number {
    return this.bets.reduce((sum, b) => sum + b.amount, 0);
  }

  getWalletAddress(): string {
    return this.config.walletAddress;
  }

  closeBetting(): void {
    this.closed = true;
  }

  openBetting(): void {
    this.closed = false;
  }

  isClosed(): boolean {
    return this.closed;
  }

  reset(): void {
    this.bets = [];
    this.closed = false;
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run server/__tests__/betting-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/betting-manager.ts server/__tests__/betting-manager.test.ts
git commit -m "feat: add BettingManager with odds calculation and payout reports"
```

---

### Task 5: Create Reputation Manager

**Files:**
- Create: `server/reputation-manager.ts`
- Test: `server/__tests__/reputation-manager.test.ts`

**Step 1: Write failing tests**

```typescript
// server/__tests__/reputation-manager.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { ReputationManager } from "../reputation-manager.js";

describe("ReputationManager", () => {
  let rm: ReputationManager;

  beforeEach(() => {
    rm = new ReputationManager();
  });

  it("initializes reputation at 5", () => {
    expect(rm.getReputation("agent-1")).toBe(5);
  });

  it("decreases reputation on betrayal", () => {
    rm.recordBetrayal("agent-1");
    expect(rm.getReputation("agent-1")).toBe(3);
  });

  it("clamps reputation at 0", () => {
    rm.recordBetrayal("agent-1");
    rm.recordBetrayal("agent-1");
    rm.recordBetrayal("agent-1");
    expect(rm.getReputation("agent-1")).toBe(0);
  });

  it("increases reputation for alliance loyalty", () => {
    rm.recordAllianceDay("agent-1");
    expect(rm.getReputation("agent-1")).toBe(5.5);
  });

  it("clamps reputation at 10", () => {
    for (let i = 0; i < 20; i++) rm.recordAllianceDay("agent-1");
    expect(rm.getReputation("agent-1")).toBe(10);
  });

  it("returns all reputations", () => {
    rm.getReputation("agent-1"); // init
    rm.getReputation("agent-2"); // init
    const all = rm.getAll();
    expect(all).toHaveLength(2);
  });

  it("checks if agent is ruthless (guilt check is external)", () => {
    // Reputation is separate from guilt; ruthless check is in alliance manager
    expect(rm.getReputation("agent-1")).toBe(5);
  });
});
```

**Step 2: Implement ReputationManager**

```typescript
// server/reputation-manager.ts
import type { ReputationRecord } from "./types.js";

export class ReputationManager {
  private records = new Map<string, ReputationRecord>();

  private ensure(agentId: string): ReputationRecord {
    let r = this.records.get(agentId);
    if (!r) {
      r = { agentId, score: 5, betrayals: 0, allianceDays: 0 };
      this.records.set(agentId, r);
    }
    return r;
  }

  getReputation(agentId: string): number {
    return this.ensure(agentId).score;
  }

  recordBetrayal(agentId: string): void {
    const r = this.ensure(agentId);
    r.betrayals++;
    r.score = Math.max(0, r.score - 2);
  }

  recordAllianceDay(agentId: string): void {
    const r = this.ensure(agentId);
    r.allianceDays++;
    r.score = Math.min(10, r.score + 0.5);
  }

  getAll(): ReputationRecord[] {
    return Array.from(this.records.values());
  }

  getRecord(agentId: string): ReputationRecord {
    return { ...this.ensure(agentId) };
  }

  reset(): void {
    // Reputation persists across rounds — don't clear
    // Only call this for full reset
    this.records.clear();
  }
}
```

**Step 3: Run tests**

Run: `npx vitest run server/__tests__/reputation-manager.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add server/reputation-manager.ts server/__tests__/reputation-manager.test.ts
git commit -m "feat: add ReputationManager with betrayal and alliance loyalty tracking"
```

---

## Phase 2: Enhanced Battle System

### Task 6: Add Momentum Punishment, Crits, and Threat Level to BattleManager

**Files:**
- Modify: `server/battle-manager.ts`
- Modify: `server/__tests__/battle-manager.test.ts`

**Step 1: Write new failing tests**

Add to `server/__tests__/battle-manager.test.ts`:

```typescript
describe("Enhanced battle mechanics", () => {
  // Use existing BattleManager setup from the file

  it("applies +15 momentum punishment when same intent used 3x", () => {
    // Start battle, submit same intent 3 turns in a row
    // 4th turn opponent should get +15 damage bonus
    // Test by checking damage values in turn resolution events
  });

  it("applies critical hit when target HP < 30 and strike lands", () => {
    // Get target to low HP, then strike
    // Crit should double damage
    // Check for crit indicator in battle events
  });

  it("calculates threat level from kills", () => {
    // Import getThreatLevel from types
    // Test: 0 kills = 1, 2 kills = 2, 4 kills = 3, 7 kills = 4, 10 kills = 5
  });

  it("rejects battle start when phase disallows combat", () => {
    // Pass a combat-allowed check function to BattleManager
    // When it returns false, startBattle should fail
  });

  it("auto-accepts challenge in showdown phase", () => {
    // This is handled at the index.ts level, not in BattleManager
    // Just verify the challenge flow
  });
});
```

Note: The exact test implementations depend on the current battle-manager test structure. The implementing agent should read the existing test file first, understand the test helpers/setup, then write tests that match the existing patterns.

**Step 2: Modify BattleManager**

Key changes to `server/battle-manager.ts`:
- Change `MOMENTUM_READ_BONUS` from 5 to 15 when same intent used 3+ times in a row
- Track `intentHistory` per agent in battle (array of last 3 intents)
- Add `criticalHit` check in `computeDamage`: if target HP < 30 and intent is "strike", 15% chance of 2x damage
- Add `crit` flag to battle events so frontend can trigger slow-mo
- Add optional `combatAllowedCheck` callback to constructor

**Step 3: Run all battle tests**

Run: `npx vitest run server/__tests__/battle-manager.test.ts`
Expected: PASS (all existing + new tests)

**Step 4: Commit**

```bash
git add server/battle-manager.ts server/__tests__/battle-manager.test.ts
git commit -m "feat: add momentum punishment (+15 at 3x repeat), critical hits, threat levels"
```

---

## Phase 3: WebSocket Protocol Upgrade

### Task 7: Upgrade WebSocket Handler for Role-Based Connections

**Files:**
- Modify: `server/index.ts` (the big one — ~45KB)

**Step 1: Understand current WS setup**

Read `server/index.ts` to find the WebSocket upgrade handler and connection handler. The current system uses a generic WS connection for browser clients.

**Step 2: Add role-based WS routing**

Add to the WebSocket upgrade handler:
- Parse `?role=agent|spectator` from URL query params
- Track agents and spectators separately in the client manager
- Agent connections: require authentication (wallet + signature — or simplified token for MVP)
- Spectator connections: read-only, broadcast all events
- Agent connections: can send commands (move, chat, battle, diplomacy)
- Spectator connections: can only send `placeBet` messages

**Step 3: Add new IPC commands for diplomacy**

Add handlers for:
- `world-alliance-propose` → AllianceManager.propose()
- `world-alliance-accept` → AllianceManager.accept()
- `world-alliance-decline` → AllianceManager.decline()
- `world-alliance-break` → AllianceManager.breakAlliance()
- `world-whisper` → private message routing
- `world-reputation` → ReputationManager.getReputation()
- `world-phase-info` → PhaseManager.getState()
- `world-alliances` → AllianceManager.getAllAlliances()

**Step 4: Integrate PhaseManager into game loop**

In the server startup:
- Create PhaseManager instance with config from env vars
- Call `phaseManager.tick(now)` in the game loop
- Listen for phase changes → broadcast PhaseMessage to all clients
- Gate combat commands on `phaseManager.isCombatAllowed()`
- Gate alliance sizes on `phaseManager.getAllianceMaxSize()`

**Step 5: Integrate AllianceManager**

- On battle start: check `allianceManager.areAllies()` — reject if allies
- On alliance break: broadcast betrayal event
- On agent leave: `allianceManager.removeAgent()`

**Step 6: Integrate BettingManager**

- Add spectator `placeBet` handler
- On phase change to "showdown": `bettingManager.closeBetting()`
- On round end: generate payout report, broadcast to admin

**Step 7: Integrate ReputationManager**

- On betrayal: `reputationManager.recordBetrayal()`
- Periodic tick: for agents in alliances, `reputationManager.recordAllianceDay()` (daily)

**Step 8: Run type check and existing tests**

Run: `npx tsc --noEmit -p tsconfig.server.json && npx vitest run`
Expected: PASS

**Step 9: Commit**

```bash
git add server/index.ts
git commit -m "feat: integrate phase manager, alliance manager, betting, reputation into server"
```

---

### Task 8: Add Zone Damage to Game Loop

**Files:**
- Modify: `server/game-loop.ts`

**Step 1: Add zone damage tick**

In the game loop tick:
- If phase is "showdown", check each agent's position against safe zone radius
- Agents outside safe zone: apply 5 HP damage per tick (adjust rate — maybe every 20 ticks = 1 second)
- Emit `ZoneDamageMessage` for each damaged agent
- If agent HP <= 0 from zone damage: trigger elimination

**Step 2: Add territory tick**

- Track how long each agent has been in a territory zone
- After 60 seconds uncontested: claim territory
- Emit `TerritoryMessage` on claim/contest/loss

**Step 3: Commit**

```bash
git add server/game-loop.ts
git commit -m "feat: add zone damage and territory claiming to game loop"
```

---

## Phase 4: Frontend Combat Visuals

### Task 9: Add Screen Shake and Slow-Motion Controller

**Files:**
- Create: `src/scene/camera-effects.ts`

**Step 1: Implement camera effects**

```typescript
// src/scene/camera-effects.ts
import * as THREE from "three";

export class CameraEffects {
  private shakeIntensity = 0;
  private shakeDuration = 0;
  private shakeStart = 0;
  private originalPosition = new THREE.Vector3();

  private slowMoFactor = 1;
  private slowMoDuration = 0;
  private slowMoStart = 0;

  private camera: THREE.Camera;

  constructor(camera: THREE.Camera) {
    this.camera = camera;
  }

  shake(intensity: number, durationMs = 300): void {
    this.shakeIntensity = intensity;
    this.shakeDuration = durationMs;
    this.shakeStart = performance.now();
    this.originalPosition.copy(this.camera.position);
  }

  slowMo(factor = 0.3, durationMs = 2000): void {
    this.slowMoFactor = factor;
    this.slowMoDuration = durationMs;
    this.slowMoStart = performance.now();
  }

  getTimeScale(): number {
    if (this.slowMoDuration <= 0) return 1;
    const elapsed = performance.now() - this.slowMoStart;
    if (elapsed >= this.slowMoDuration) {
      this.slowMoDuration = 0;
      return 1;
    }
    // Ease out of slow-mo in last 500ms
    const remaining = this.slowMoDuration - elapsed;
    if (remaining < 500) {
      return this.slowMoFactor + (1 - this.slowMoFactor) * (1 - remaining / 500);
    }
    return this.slowMoFactor;
  }

  update(): void {
    if (this.shakeDuration <= 0) return;
    const elapsed = performance.now() - this.shakeStart;
    if (elapsed >= this.shakeDuration) {
      this.camera.position.copy(this.originalPosition);
      this.shakeDuration = 0;
      return;
    }
    const decay = 1 - elapsed / this.shakeDuration;
    const offsetX = (Math.random() - 0.5) * this.shakeIntensity * decay;
    const offsetY = (Math.random() - 0.5) * this.shakeIntensity * decay;
    this.camera.position.set(
      this.originalPosition.x + offsetX,
      this.originalPosition.y + offsetY,
      this.originalPosition.z
    );
  }
}
```

**Step 2: Commit**

```bash
git add src/scene/camera-effects.ts
git commit -m "feat: add CameraEffects with screen shake and slow-motion"
```

---

### Task 10: Add Battle Visual Sequencer

**Files:**
- Create: `src/scene/battle-sequencer.ts`

This component watches for `turn_resolved` events and orchestrates the visual sequence:
1. Camera zoom to battle
2. Play intent animations on both lobsters (using existing `animateStrike`, `animateGuard`, etc.)
3. On impact: trigger screen shake (intensity = damage/10), spawn damage particles, show floating damage numbers
4. On kill: trigger slow-mo, camera orbit, death particles, victory pose
5. Camera return to overview

**Step 1: Implement battle sequencer**

The sequencer should:
- Queue battle events and play them in sequence
- Use `requestAnimationFrame` timing with the slow-mo time scale
- Call existing animation functions from `lobster.ts` (`animateStrike`, `animateGuard`, `animateFeint`, etc.)
- Call `CameraEffects.shake()` on hit
- Call `CameraEffects.slowMo()` on killing blow
- Call `EffectsManager.showDamage()` for floating numbers (already exists)

**Step 2: Integrate into main render loop**

In `src/main.ts` (the world entry point):
- Create `CameraEffects` instance
- Create `BattleSequencer` instance
- On `turn_resolved` WS event: feed into sequencer
- In render loop: call `cameraEffects.update()` and `battleSequencer.update(deltaTime * cameraEffects.getTimeScale())`

**Step 3: Commit**

```bash
git add src/scene/battle-sequencer.ts src/main.ts
git commit -m "feat: add BattleSequencer for animated combat turns with camera effects"
```

---

### Task 11: Add New Particle Presets

**Files:**
- Modify: `src/scene/particle-engine.ts`

**Step 1: Add new presets**

Add particle presets for:
- `crit_hit`: Large red/gold burst with extra particles, longer duration
- `betrayal_flash`: Purple/dark red flash expanding ring
- `zone_damage`: Red crackling particles around agent (continuous while outside zone)
- `territory_claim`: Green/blue rising particles (pillar effect)
- `battle_arena`: Circular ring of small particles around combatants

**Step 2: Commit**

```bash
git add src/scene/particle-engine.ts
git commit -m "feat: add particle presets for crits, betrayals, zones, territory"
```

---

## Phase 5: Spectator UI

### Task 12: Add Kill Feed

**Files:**
- Create: `src/ui/kill-feed.ts`
- Modify: `src/style.css`

**Step 1: Implement kill feed**

FPS-style kill feed in top-right corner:
- Shows: kills ("Agent X eliminated Agent Y"), betrayals ("Agent X BETRAYED Agent Y!"), alliances ("Agent X + Agent Y formed alliance")
- Max 5 entries visible, fade out after 10 seconds
- Red highlight for kills, purple for betrayals, green for alliances
- Positioned below the agent count

**Step 2: Add CSS styles**

Add to `src/style.css`:
- `.kill-feed` container (fixed top-right, z-index above 3D)
- `.kill-feed-entry` with slide-in animation and fade-out
- Color classes for different event types

**Step 3: Commit**

```bash
git add src/ui/kill-feed.ts src/style.css
git commit -m "feat: add kill feed overlay for kills, betrayals, alliances"
```

---

### Task 13: Add Phase Banner

**Files:**
- Create: `src/ui/phase-banner.ts`
- Modify: `src/style.css`

**Step 1: Implement phase banner**

Full-screen announcement on phase transitions:
- Large text: "BATTLE PHASE BEGINS", "FINAL SHOWDOWN", "ROUND ENDED"
- Dramatic entrance animation (scale up + fade in)
- Stays for 3 seconds, then fades out
- Includes phase description subtitle

**Step 2: Add CSS with animations**

**Step 3: Commit**

```bash
git add src/ui/phase-banner.ts src/style.css
git commit -m "feat: add phase transition banner with dramatic animations"
```

---

### Task 14: Add Minimap

**Files:**
- Create: `src/ui/minimap.ts`
- Modify: `src/style.css`

**Step 1: Implement minimap**

Canvas-based minimap in top-left:
- 200x200px canvas
- Draw terrain outline (circle for island)
- Draw agent dots (colored by alliance, white if no alliance)
- Draw safe zone boundary (animated red ring during showdown)
- Draw territory zones (colored regions)
- Click to move camera to that position

**Step 2: Add CSS**

**Step 3: Commit**

```bash
git add src/ui/minimap.ts src/style.css
git commit -m "feat: add minimap with agent dots, safe zone, and territory"
```

---

### Task 15: Add Leaderboard Sidebar

**Files:**
- Create: `src/ui/leaderboard.ts`
- Modify: `src/style.css`

**Step 1: Implement leaderboard**

Right sidebar showing:
- Agent name, threat level (star icons), kills, reputation score, alliance name
- Sorted by kills (descending)
- Dead agents grayed out with skull icon
- Click to follow agent

**Step 2: Commit**

```bash
git add src/ui/leaderboard.ts src/style.css
git commit -m "feat: add leaderboard sidebar with threat levels and reputation"
```

---

### Task 16: Add Betting Panel (Spectator Only)

**Files:**
- Create: `src/ui/betting-panel.ts`
- Modify: `src/style.css`

**Step 1: Implement betting panel**

Shows:
- Admin wallet address for sending USDC
- Agent list with current implied odds
- Input for tx hash + amount + agent selection
- "Place Bet" button → sends WS message
- Total pool size
- "BETTING CLOSED" state during showdown
- Payout report display after round ends

**Step 2: Commit**

```bash
git add src/ui/betting-panel.ts src/style.css
git commit -m "feat: add betting panel for spectators with odds display"
```

---

### Task 17: Add Event Ticker

**Files:**
- Create: `src/ui/event-ticker.ts`
- Modify: `src/style.css`

**Step 1: Implement ticker**

Bottom-of-screen scrolling text:
- Shows all major events in one line
- Scrolls left continuously
- New events appear on the right
- Events: phase changes, kills, alliances, territory claims, bets

**Step 2: Commit**

```bash
git add src/ui/event-ticker.ts src/style.css
git commit -m "feat: add scrolling event ticker at bottom of screen"
```

---

### Task 18: Add Auto-Camera Director

**Files:**
- Create: `src/scene/camera-director.ts`
- Modify: `src/main.ts`

**Step 1: Implement camera director**

Priority-based camera targeting:
- Score events: killing_blow=100, battle_started=80, betrayal=70, alliance_formed=50, agent_chat=10, idle=1
- Smooth lerp camera to highest-priority target
- Stay on battles until they resolve (lock)
- If nothing interesting for 10s: slow orbit overview
- Click agent in sidebar/minimap to override (manual follow)
- Click empty space to return to auto mode

**Step 2: Integrate into render loop**

**Step 3: Commit**

```bash
git add src/scene/camera-director.ts src/main.ts
git commit -m "feat: add auto-camera director that follows action events"
```

---

## Phase 6: Agent SKILL.md Rewrite

### Task 19: Rewrite SKILL.md for LLM Agents

**Files:**
- Modify: `skills/SKILL.md` (or wherever the main skill doc is)

**Step 1: Write comprehensive agent manual**

The SKILL.md should cover:
1. **Overview**: What is OpenClaw World, what does the agent need to do
2. **Connection**: WebSocket URL, authentication flow, example messages
3. **Events Reference**: Every event type with full JSON schema and example payload
4. **Commands Reference**: Every command with parameters, validation rules, example usage
5. **Phase Rules**: What's allowed in each phase, when combat starts, zone shrinking
6. **Diplomacy Guide**: How to propose/accept/break alliances, reputation impact
7. **Battle Guide**: Damage matrix, stamina costs, momentum punishment, crits
8. **Strategy Hints**: Alliance tactics, when to betray, zone positioning
9. **Example Agent Loop**: Pseudocode for a basic agent decision loop

**Step 2: Commit**

```bash
git add skills/SKILL.md
git commit -m "docs: rewrite SKILL.md as comprehensive LLM agent manual"
```

---

## Phase 7: Integration & Polish

### Task 20: Wire Everything Together in index.ts

**Files:**
- Modify: `server/index.ts`

Final integration pass:
- Ensure all managers are instantiated and wired
- Test the full flow: agent connects → lobby → battle → showdown → winner
- Admin API updates: start/stop round uses PhaseManager
- Broadcast phase changes, zone updates, alliance events to all clients
- Handle edge cases: agent disconnect during battle, alliance dissolution on phase change

**Step 1: Integration testing**

Manual testing with the dev server:
1. Start server with `npm run dev:server`
2. Connect via WebSocket as agent
3. Connect via WebSocket as spectator
4. Verify events flow correctly
5. Test phase transitions
6. Test battle with visual sequencer

**Step 2: Commit**

```bash
git add server/index.ts
git commit -m "feat: wire all systems together - phases, alliances, betting, combat"
```

---

### Task 21: Update Frontend Entry Point

**Files:**
- Modify: `src/main.ts`

Wire all new UI components:
- Initialize kill feed, phase banner, minimap, leaderboard, betting panel, event ticker
- Connect to WS events
- Initialize camera director and battle sequencer
- Handle spectator vs viewer mode (check URL params)

**Step 1: Commit**

```bash
git add src/main.ts
git commit -m "feat: integrate all new UI components and camera systems into main"
```

---

### Task 22: Add Agent Count HUD

**Files:**
- Modify: `src/ui/overlay.ts` or create `src/ui/agent-count.ts`
- Modify: `src/style.css`

Always-visible "12 ALIVE / 20 ENTERED" counter at top-center of screen.

**Step 1: Commit**

```bash
git add src/ui/agent-count.ts src/style.css
git commit -m "feat: add always-visible agent count HUD"
```

---

### Task 23: Run Full Test Suite and Fix Issues

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 2: Run type checks**

Run: `npx tsc --noEmit -p tsconfig.server.json && npx tsc --noEmit`
Expected: No errors

**Step 3: Run dev server and verify**

Run: `npm run dev`
Verify: Server starts, frontend loads, WebSocket connects

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve integration issues from full test suite run"
```

---

## Task Dependency Graph

```
Phase 1 (Foundation):
  Task 1 (Types) → Task 2 (PhaseManager) → Task 3 (AllianceManager) → Task 4 (BettingManager) → Task 5 (ReputationManager)

Phase 2 (Battle):
  Task 1 → Task 6 (Enhanced Battle)

Phase 3 (WebSocket):
  Tasks 2-6 → Task 7 (WS Upgrade) → Task 8 (Zone Damage)

Phase 4 (Visuals):
  Task 9 (Camera Effects) → Task 10 (Battle Sequencer)
  Task 11 (Particles) — independent

Phase 5 (UI):
  Tasks 12-18 — mostly independent, can parallelize
  Task 18 (Camera Director) depends on Task 9

Phase 6 (SKILL.md):
  Task 19 — depends on Tasks 7-8 (needs final API)

Phase 7 (Integration):
  Tasks 20-23 — depends on everything above
```

## Parallelization Opportunities

These task groups can run in parallel:
- **Group A**: Tasks 2, 3, 4, 5 (server managers — independent of each other)
- **Group B**: Tasks 9, 10, 11 (frontend visuals — independent of server)
- **Group C**: Tasks 12, 13, 14, 15, 16, 17 (UI components — independent of each other)

Sequential dependencies:
- Task 1 must complete before anything else
- Task 7 must complete before Task 8
- Task 6 can run parallel with Tasks 2-5
- Tasks 20-23 must run after everything else
