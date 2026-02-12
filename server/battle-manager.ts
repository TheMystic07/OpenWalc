import type {
  AgentPosition,
  BattleEndReason,
  BattleIntent,
  BattleMessage,
  BattleStateSummary,
} from "./types.js";

const BATTLE_START_RANGE = 12;
const MAX_HP = 100;

interface ActiveBattle {
  battleId: string;
  participants: [string, string];
  hp: Record<string, number>;
  power: Record<string, number>;
  intents: Partial<Record<string, BattleIntent>>;
  turn: number;
  startedAt: number;
  updatedAt: number;
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
      .map((battle) => ({
        battleId: battle.battleId,
        participants: battle.participants,
        turn: battle.turn,
        hp: { ...battle.hp },
        pending: battle.participants.filter((id) => !battle.intents[id]),
        startedAt: battle.startedAt,
        updatedAt: battle.updatedAt,
      }));
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

    const battle: ActiveBattle = {
      battleId,
      participants,
      hp,
      power,
      intents: {},
      turn: 1,
      startedAt: timestamp,
      updatedAt: timestamp,
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

    battle.intents[agentId] = intent;
    battle.updatedAt = timestamp;

    const intentEvent: BattleMessage = {
      worldType: "battle",
      agentId,
      battleId,
      phase: "intent",
      participants: battle.participants,
      turn: battle.turn,
      hp: { ...battle.hp },
      actorId: agentId,
      intent,
      summary: `${agentId} locked intent: ${intent} (turn ${battle.turn}).`,
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

  private resolveTurn(battle: ActiveBattle, timestamp: number): BattleMessage[] {
    const [a, b] = battle.participants;
    const intentA = battle.intents[a] ?? "guard";
    const intentB = battle.intents[b] ?? "guard";
    const turn = battle.turn;

    const damageToB = this.computeDamage(intentA, intentB, battle.power[a]);
    const damageToA = this.computeDamage(intentB, intentA, battle.power[b]);

    battle.hp[a] = Math.max(0, battle.hp[a] - damageToA);
    battle.hp[b] = Math.max(0, battle.hp[b] - damageToB);
    battle.updatedAt = timestamp;

    const roundSummary =
      `Turn ${turn}: ${a}(${intentA}) -> ${damageToB} dmg, ` +
      `${b}(${intentB}) -> ${damageToA} dmg. HP ${a}:${battle.hp[a]} ${b}:${battle.hp[b]}`;

    const roundEvent: BattleMessage = {
      worldType: "battle",
      agentId: a,
      battleId: battle.battleId,
      phase: "round",
      participants: battle.participants,
      turn,
      hp: { ...battle.hp },
      damage: { [a]: damageToA, [b]: damageToB },
      intents: { [a]: intentA, [b]: intentB },
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

    if (intentA === "retreat") {
      return this.makeEndedMessage(
        battle,
        b,
        a,
        "retreat",
        `${a} retreated. ${b} wins.`,
        [],
        timestamp,
      );
    }
    if (intentB === "retreat") {
      return this.makeEndedMessage(
        battle,
        a,
        b,
        "retreat",
        `${b} retreated. ${a} wins.`,
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

  private computeDamage(attackerIntent: BattleIntent, defenderIntent: BattleIntent, attackerPower: number): number {
    let base = 0;
    switch (attackerIntent) {
      case "strike": {
        if (defenderIntent === "guard") base = 10;
        else if (defenderIntent === "feint") base = 28;
        else if (defenderIntent === "retreat") base = 30;
        else base = 22;
        break;
      }
      case "feint": {
        if (defenderIntent === "guard") base = 20;
        else if (defenderIntent === "retreat") base = 22;
        else base = 14;
        break;
      }
      case "approach": {
        base = defenderIntent === "retreat" ? 8 : 4;
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
    };
  }
}
