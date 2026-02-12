import type {
  AgentPosition,
  BattleEndReason,
  BattleIntent,
  BattleMessage,
  BattleStateSummary,
} from "./types.js";

const BATTLE_START_RANGE = 12;
const MAX_HP = 100;
const MAX_STAMINA = 100;
const TURN_TIMEOUT_MS = 30_000;

/** Stamina cost per intent (guard recovers instead) */
const STAMINA_COST: Record<BattleIntent, number> = {
  strike: 20,
  feint: 15,
  approach: 5,
  guard: 0,
  retreat: 10,
};

const GUARD_STAMINA_RECOVERY = 10;
const MOMENTUM_READ_BONUS = 5;

interface ActiveBattle {
  battleId: string;
  participants: [string, string];
  hp: Record<string, number>;
  power: Record<string, number>;
  stamina: Record<string, number>;
  intents: Partial<Record<string, BattleIntent>>;
  /** Previous turn's intents for momentum detection */
  prevIntents: Partial<Record<string, BattleIntent>>;
  turn: number;
  startedAt: number;
  updatedAt: number;
  /** When the current turn began (for timeout) */
  turnStartedAt: number;
  /** Agents who have proposed a truce (persists across turns) */
  truceProposals: Set<string>;
}

export class BattleManager {
  private battles = new Map<string, ActiveBattle>();
  private agentToBattle = new Map<string, string>();
  private nextBattleId = 1;

  isInBattle(agentId: string): boolean {
    return this.agentToBattle.has(agentId);
  }

  getBattleIdForAgent(agentId: string): string | null {
    return this.agentToBattle.get(agentId) ?? null;
  }

  listActive(): BattleStateSummary[] {
    const battles = Array.from(this.battles.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((battle) => this.toSummary(battle));
    return battles;
  }

  startBattle(
    attackerId: string,
    defenderId: string,
    attackerPos: AgentPosition | undefined,
    defenderPos: AgentPosition | undefined,
    powers?: { attacker?: number; defender?: number },
    timestamp = Date.now(),
  ): { ok: true; battle: BattleStateSummary; events: BattleMessage[] } | { ok: false; error: string } {
    if (attackerId === defenderId) {
      return { ok: false, error: "Cannot start battle with yourself" };
    }
    if (!attackerPos || !defenderPos) {
      return { ok: false, error: "Both agents must be present in the world" };
    }
    if (this.isInBattle(attackerId) || this.isInBattle(defenderId)) {
      return { ok: false, error: "One or more agents are already in a battle" };
    }

    const dx = attackerPos.x - defenderPos.x;
    const dz = attackerPos.z - defenderPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > BATTLE_START_RANGE) {
      return {
        ok: false,
        error: `Target is too far away (${dist.toFixed(1)} > ${BATTLE_START_RANGE})`,
      };
    }

    const battleId = `battle-${this.nextBattleId++}`;
    const participants: [string, string] = [attackerId, defenderId];
    const hp: Record<string, number> = {
      [attackerId]: MAX_HP,
      [defenderId]: MAX_HP,
    };
    const power: Record<string, number> = {
      [attackerId]: this.normalizePower(powers?.attacker),
      [defenderId]: this.normalizePower(powers?.defender),
    };
    const stamina: Record<string, number> = {
      [attackerId]: MAX_STAMINA,
      [defenderId]: MAX_STAMINA,
    };

    const battle: ActiveBattle = {
      battleId,
      participants,
      hp,
      power,
      stamina,
      intents: {},
      prevIntents: {},
      turn: 1,
      startedAt: timestamp,
      updatedAt: timestamp,
      turnStartedAt: timestamp,
      truceProposals: new Set(),
    };

    this.battles.set(battleId, battle);
    this.agentToBattle.set(attackerId, battleId);
    this.agentToBattle.set(defenderId, battleId);

    const startedEvent: BattleMessage = {
      worldType: "battle",
      agentId: attackerId,
      battleId,
      phase: "started",
      participants,
      turn: 1,
      hp: { ...hp },
      stamina: { ...stamina },
      summary: `${attackerId} challenged ${defenderId}. Turn 1 started.`,
      timestamp,
    };

    return {
      ok: true,
      battle: this.toSummary(battle),
      events: [startedEvent],
    };
  }

  submitIntent(
    agentId: string,
    battleId: string,
    intent: BattleIntent,
    timestamp = Date.now(),
  ): { ok: true; battle: BattleStateSummary | null; events: BattleMessage[] } | { ok: false; error: string } {
    const battle = this.battles.get(battleId);
    if (!battle) return { ok: false, error: "Battle not found" };
    if (!battle.participants.includes(agentId)) {
      return { ok: false, error: "Agent is not a participant in this battle" };
    }
    if (battle.intents[agentId]) {
      return { ok: false, error: "Intent already submitted for this turn" };
    }

    // Enforce stamina — downgrade to guard if insufficient
    let effectiveIntent = intent;
    const cost = STAMINA_COST[intent];
    if (cost > 0 && battle.stamina[agentId] < cost) {
      effectiveIntent = "guard";
    }

    battle.intents[agentId] = effectiveIntent;
    battle.updatedAt = timestamp;

    const forced = effectiveIntent !== intent;
    const intentEvent: BattleMessage = {
      worldType: "battle",
      agentId,
      battleId,
      phase: "intent",
      participants: battle.participants,
      turn: battle.turn,
      hp: { ...battle.hp },
      stamina: { ...battle.stamina },
      actorId: agentId,
      intent: effectiveIntent,
      summary: forced
        ? `${agentId} tried ${intent} but lacked stamina — forced to guard (turn ${battle.turn}).`
        : `${agentId} locked intent: ${effectiveIntent} (turn ${battle.turn}).`,
      timestamp,
    };

    const events: BattleMessage[] = [intentEvent];
    if (this.hasTurnReady(battle)) {
      events.push(...this.resolveTurn(battle, timestamp));
    }

    return {
      ok: true,
      battle: this.battles.has(battleId) ? this.toSummary(this.battles.get(battleId)!) : null,
      events,
    };
  }

  proposeTruce(
    agentId: string,
    battleId: string,
    timestamp = Date.now(),
  ): { ok: true; battle: BattleStateSummary | null; events: BattleMessage[]; accepted: boolean } | { ok: false; error: string } {
    const battle = this.battles.get(battleId);
    if (!battle) return { ok: false, error: "Battle not found" };
    if (!battle.participants.includes(agentId)) {
      return { ok: false, error: "Agent is not a participant in this battle" };
    }

    if (battle.truceProposals.has(agentId)) {
      return { ok: false, error: "Truce already proposed" };
    }

    battle.truceProposals.add(agentId);
    battle.updatedAt = timestamp;
    const opponent = battle.participants.find((id) => id !== agentId)!;

    // Both proposed — end the battle peacefully
    if (battle.truceProposals.has(opponent)) {
      const ended = this.makeEndedMessage(
        battle,
        undefined,
        undefined,
        "truce",
        `${agentId} and ${opponent} agreed to a truce. Battle ended peacefully.`,
        [],
        timestamp,
      );
      this.finishBattle(battle);
      return { ok: true, battle: null, events: [ended], accepted: true };
    }

    // Only one side proposed — notify and wait
    const proposeEvent: BattleMessage = {
      worldType: "battle",
      agentId,
      battleId,
      phase: "intent",
      participants: battle.participants,
      turn: battle.turn,
      hp: { ...battle.hp },
      stamina: { ...battle.stamina },
      summary: `${agentId} proposes a truce. ${opponent} can accept with truce or keep fighting.`,
      timestamp,
    };

    return {
      ok: true,
      battle: this.toSummary(battle),
      events: [proposeEvent],
      accepted: false,
    };
  }

  surrender(
    agentId: string,
    battleId: string,
    timestamp = Date.now(),
  ): { ok: true; battle: null; events: BattleMessage[] } | { ok: false; error: string } {
    const battle = this.battles.get(battleId);
    if (!battle) return { ok: false, error: "Battle not found" };
    if (!battle.participants.includes(agentId)) {
      return { ok: false, error: "Agent is not a participant in this battle" };
    }
    const opponent = battle.participants.find((id) => id !== agentId);
    const ended = this.makeEndedMessage(
      battle,
      opponent ?? battle.participants[0],
      agentId,
      "surrender",
      `${agentId} surrendered.`,
      [],
      timestamp,
    );
    this.finishBattle(battle);
    return { ok: true, battle: null, events: [ended] };
  }

  handleAgentLeave(agentId: string, timestamp = Date.now()): BattleMessage[] {
    const battleId = this.agentToBattle.get(agentId);
    if (!battleId) return [];
    const battle = this.battles.get(battleId);
    if (!battle) return [];

    const opponent = battle.participants.find((id) => id !== agentId);
    const winner = opponent ?? battle.participants[0];
    const loser = opponent ? agentId : undefined;
    const reason: BattleEndReason = opponent ? "disconnect" : "draw";
    const summary = opponent
      ? `${agentId} left the world. ${winner} wins by disconnect.`
      : `${agentId} left the world. Battle ended.`;

    const ended = this.makeEndedMessage(
      battle,
      winner,
      loser,
      reason,
      summary,
      [],
      timestamp,
    );
    this.finishBattle(battle);
    return [ended];
  }

  /** Check all battles for turn timeouts. Called periodically from the game loop. */
  checkTimeouts(timestamp = Date.now()): BattleMessage[] {
    const allEvents: BattleMessage[] = [];

    for (const battle of this.battles.values()) {
      if (timestamp - battle.turnStartedAt < TURN_TIMEOUT_MS) continue;

      const timedOut: string[] = [];
      for (const agentId of battle.participants) {
        if (!battle.intents[agentId]) {
          battle.intents[agentId] = "guard";
          timedOut.push(agentId);
        }
      }

      if (timedOut.length > 0 && this.hasTurnReady(battle)) {
        const timeoutEvent: BattleMessage = {
          worldType: "battle",
          agentId: battle.participants[0],
          battleId: battle.battleId,
          phase: "intent",
          participants: battle.participants,
          turn: battle.turn,
          hp: { ...battle.hp },
          stamina: { ...battle.stamina },
          timedOut,
          summary: `Turn ${battle.turn} timed out. ${timedOut.join(", ")} auto-guarded.`,
          timestamp,
        };
        allEvents.push(timeoutEvent);
        allEvents.push(...this.resolveTurn(battle, timestamp));
      }
    }

    return allEvents;
  }

  private resolveTurn(battle: ActiveBattle, timestamp: number): BattleMessage[] {
    const [a, b] = battle.participants;
    const intentA = battle.intents[a] ?? "guard";
    const intentB = battle.intents[b] ?? "guard";
    const turn = battle.turn;

    // --- Stamina: apply costs and guard recovery ---
    for (const [agentId, intent] of [[a, intentA], [b, intentB]] as [string, BattleIntent][]) {
      if (intent === "guard") {
        battle.stamina[agentId] = Math.min(MAX_STAMINA, battle.stamina[agentId] + GUARD_STAMINA_RECOVERY);
      } else {
        battle.stamina[agentId] = Math.max(0, battle.stamina[agentId] - STAMINA_COST[intent]);
      }
    }

    // --- Momentum read bonus: +5 if opponent repeated their previous intent ---
    const readBonusA = (battle.prevIntents[b] != null && battle.prevIntents[b] === intentB) ? MOMENTUM_READ_BONUS : 0;
    const readBonusB = (battle.prevIntents[a] != null && battle.prevIntents[a] === intentA) ? MOMENTUM_READ_BONUS : 0;

    // --- Damage computation ---
    const baseDmgToB = this.computeDamage(intentA, intentB, battle.power[a]);
    const baseDmgToA = this.computeDamage(intentB, intentA, battle.power[b]);

    // Read bonus only applies when there's base damage to amplify
    const damageToB = baseDmgToB > 0 ? baseDmgToB + readBonusA : 0;
    const damageToA = baseDmgToA > 0 ? baseDmgToA + readBonusB : 0;

    battle.hp[a] = Math.max(0, battle.hp[a] - damageToA);
    battle.hp[b] = Math.max(0, battle.hp[b] - damageToB);
    battle.updatedAt = timestamp;

    // Store intents for next turn's momentum check
    battle.prevIntents = { [a]: intentA, [b]: intentB };

    const readBonus: Record<string, number> = {};
    if (readBonusA > 0) readBonus[a] = readBonusA;
    if (readBonusB > 0) readBonus[b] = readBonusB;

    const roundSummary =
      `Turn ${turn}: ${a}(${intentA}) -> ${damageToB} dmg` +
      (readBonusA > 0 ? ` (+${readBonusA} read)` : "") +
      `, ${b}(${intentB}) -> ${damageToA} dmg` +
      (readBonusB > 0 ? ` (+${readBonusB} read)` : "") +
      `. HP ${a}:${battle.hp[a]} ${b}:${battle.hp[b]}` +
      ` | STA ${a}:${battle.stamina[a]} ${b}:${battle.stamina[b]}`;

    const roundEvent: BattleMessage = {
      worldType: "battle",
      agentId: a,
      battleId: battle.battleId,
      phase: "round",
      participants: battle.participants,
      turn,
      hp: { ...battle.hp },
      stamina: { ...battle.stamina },
      damage: { [a]: damageToA, [b]: damageToB },
      intents: { [a]: intentA, [b]: intentB },
      readBonus: Object.keys(readBonus).length > 0 ? readBonus : undefined,
      summary: roundSummary,
      timestamp,
    };

    const events = [roundEvent];
    const end = this.getRoundEndState(battle, intentA, intentB, timestamp);
    if (end) {
      events.push(end);
      this.finishBattle(battle);
      return events;
    }

    battle.turn += 1;
    battle.intents = {};
    battle.turnStartedAt = timestamp;
    return events;
  }

  private getRoundEndState(
    battle: ActiveBattle,
    intentA: BattleIntent,
    intentB: BattleIntent,
    timestamp: number,
  ): BattleMessage | null {
    const [a, b] = battle.participants;

    const bothRetreat = intentA === "retreat" && intentB === "retreat";
    if (bothRetreat) {
      return this.makeEndedMessage(
        battle,
        undefined,
        undefined,
        "draw",
        "Both agents retreated. Battle ended in a draw.",
        [],
        timestamp,
      );
    }

    // Retreat = flee: the agent escapes. No winner, no loser — just a clean exit.
    // The fleeing agent still takes damage from this turn's resolution.
    if (intentA === "retreat") {
      return this.makeEndedMessage(
        battle,
        undefined,
        undefined,
        "flee",
        `${a} fled the battle. No winner declared.`,
        [],
        timestamp,
      );
    }
    if (intentB === "retreat") {
      return this.makeEndedMessage(
        battle,
        undefined,
        undefined,
        "flee",
        `${b} fled the battle. No winner declared.`,
        [],
        timestamp,
      );
    }

    const aDown = battle.hp[a] <= 0;
    const bDown = battle.hp[b] <= 0;
    if (aDown && bDown) {
      return this.makeEndedMessage(
        battle,
        undefined,
        undefined,
        "draw",
        `Both ${a} and ${b} were knocked out. Draw.`,
        [a, b],
        timestamp,
      );
    }
    if (aDown) {
      return this.makeEndedMessage(
        battle,
        b,
        a,
        "ko",
        `${b} knocked out ${a}.`,
        [a],
        timestamp,
      );
    }
    if (bDown) {
      return this.makeEndedMessage(
        battle,
        a,
        b,
        "ko",
        `${a} knocked out ${b}.`,
        [b],
        timestamp,
      );
    }

    return null;
  }

  /** Rebalanced damage matrix */
  private computeDamage(attackerIntent: BattleIntent, defenderIntent: BattleIntent, attackerPower: number): number {
    let base = 0;
    switch (attackerIntent) {
      case "strike": {
        if (defenderIntent === "guard") base = 10;
        else if (defenderIntent === "strike") base = 18;
        else if (defenderIntent === "feint") base = 28;
        else if (defenderIntent === "retreat") base = 30;
        else base = 22; // vs approach
        break;
      }
      case "feint": {
        if (defenderIntent === "guard") base = 10;
        else if (defenderIntent === "retreat") base = 22;
        else base = 14; // vs approach, strike, feint
        break;
      }
      case "approach": {
        base = defenderIntent === "retreat" ? 12 : 4;
        break;
      }
      case "guard":
      case "retreat":
      default:
        base = 0;
        break;
    }
    if (base <= 0) return 0;
    return Math.max(1, Math.round(base * attackerPower));
  }

  private normalizePower(power: number | undefined): number {
    const n = Number(power ?? 1);
    if (!isFinite(n)) return 1;
    return Math.min(1.5, Math.max(1, n));
  }

  private hasTurnReady(battle: ActiveBattle): boolean {
    const [a, b] = battle.participants;
    return Boolean(battle.intents[a] && battle.intents[b]);
  }

  private finishBattle(battle: ActiveBattle): void {
    this.battles.delete(battle.battleId);
    for (const agentId of battle.participants) {
      this.agentToBattle.delete(agentId);
    }
  }

  private makeEndedMessage(
    battle: ActiveBattle,
    winnerId: string | undefined,
    loserId: string | undefined,
    reason: BattleEndReason,
    summary: string,
    defeatedIds: string[],
    timestamp: number,
  ): BattleMessage {
    return {
      worldType: "battle",
      agentId: winnerId ?? battle.participants[0],
      battleId: battle.battleId,
      phase: "ended",
      participants: battle.participants,
      turn: battle.turn,
      hp: { ...battle.hp },
      stamina: { ...battle.stamina },
      winnerId,
      loserId,
      defeatedIds: defeatedIds.length > 0 ? defeatedIds : undefined,
      reason,
      summary,
      timestamp,
    };
  }

  private toSummary(battle: ActiveBattle): BattleStateSummary {
    return {
      battleId: battle.battleId,
      participants: battle.participants,
      turn: battle.turn,
      hp: { ...battle.hp },
      pending: battle.participants.filter((id) => !battle.intents[id]),
      startedAt: battle.startedAt,
      updatedAt: battle.updatedAt,
      stamina: { ...battle.stamina },
      turnDeadline: battle.turnStartedAt + TURN_TIMEOUT_MS,
    };
  }
}
