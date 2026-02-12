import { describe, it, expect, beforeEach } from "vitest";
import { BattleManager } from "../battle-manager.js";
import type { AgentPosition } from "../types.js";

function makePos(agentId: string, x: number, z: number): AgentPosition {
  return {
    agentId,
    x,
    y: 0,
    z,
    rotation: 0,
    timestamp: Date.now(),
  };
}

function startNearby(manager: BattleManager, ts = 1000) {
  const result = manager.startBattle(
    "lobster-a",
    "lobster-b",
    makePos("lobster-a", 0, 0),
    makePos("lobster-b", 3, 4),
    undefined,
    ts,
  );
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("BattleManager", () => {
  let manager: BattleManager;

  beforeEach(() => {
    manager = new BattleManager();
  });

  // ── Core battle lifecycle ─────────────────────────────────────

  it("starts a battle when agents are nearby", () => {
    const result = startNearby(manager);
    expect(result.battle.participants).toEqual(["lobster-a", "lobster-b"]);
    expect(result.events[0].phase).toBe("started");
    expect(manager.isInBattle("lobster-a")).toBe(true);
  });

  it("rejects battle start when target is too far", () => {
    const result = manager.startBattle(
      "lobster-a",
      "lobster-b",
      makePos("lobster-a", 0, 0),
      makePos("lobster-b", 50, 50),
      undefined,
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/too far/i);
  });

  it("resolves a round after both intents are submitted", () => {
    const { battle } = startNearby(manager);
    const battleId = battle.battleId;

    const firstIntent = manager.submitIntent("lobster-a", battleId, "strike", 1100);
    expect(firstIntent.ok).toBe(true);
    if (!firstIntent.ok) return;
    expect(firstIntent.events).toHaveLength(1);
    expect(firstIntent.events[0].phase).toBe("intent");

    const secondIntent = manager.submitIntent("lobster-b", battleId, "guard", 1200);
    expect(secondIntent.ok).toBe(true);
    if (!secondIntent.ok) return;
    expect(secondIntent.events.map((ev) => ev.phase)).toEqual(["intent", "round"]);
    const round = secondIntent.events.find((ev) => ev.phase === "round");
    expect(round?.damage).toBeTruthy();
    expect(secondIntent.battle?.turn).toBe(2);
  });

  it("ends battle when one side surrenders", () => {
    const { battle } = startNearby(manager);
    const result = manager.surrender("lobster-a", battle.battleId, 2000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0].phase).toBe("ended");
    expect(result.events[0].reason).toBe("surrender");
    expect(manager.isInBattle("lobster-a")).toBe(false);
    expect(manager.isInBattle("lobster-b")).toBe(false);
  });

  it("ends battle on disconnect with opponent as winner", () => {
    startNearby(manager);
    const events = manager.handleAgentLeave("lobster-a", 3000);
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe("ended");
    expect(events[0].reason).toBe("disconnect");
    expect(events[0].winnerId).toBe("lobster-b");
  });

  it("marks defeated agent ids when battle ends by KO", () => {
    const { battle } = startNearby(manager);
    const battleId = battle.battleId;
    let endedEvent: { phase: string; reason?: string; defeatedIds?: string[] } | null = null;

    // strike vs feint: strike deals 28 to feint, feint deals 14 to strike
    for (let turn = 0; turn < 5; turn++) {
      const aIntent = manager.submitIntent("lobster-a", battleId, "strike", 1100 + turn * 10);
      if (!aIntent.ok) break;

      const bIntent = manager.submitIntent("lobster-b", battleId, "feint", 1105 + turn * 10);
      if (!bIntent.ok) break;

      endedEvent = bIntent.events.find((ev) => ev.phase === "ended") ?? endedEvent;
      if (endedEvent) break;
    }

    expect(endedEvent).toBeTruthy();
    if (!endedEvent) return;
    expect(endedEvent.reason).toBe("ko");
    expect(endedEvent.defeatedIds).toEqual(["lobster-b"]);
  });

  // ── Stamina system ────────────────────────────────────────────

  describe("Stamina system", () => {
    it("starts both agents at 100 stamina", () => {
      const result = startNearby(manager);
      expect(result.events[0].stamina).toEqual({
        "lobster-a": 100,
        "lobster-b": 100,
      });
      expect(result.battle.stamina).toEqual({
        "lobster-a": 100,
        "lobster-b": 100,
      });
    });

    it("deducts stamina on strike (20) and feint (15)", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "strike", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "feint", 1200);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      expect(round?.stamina?.["lobster-a"]).toBe(80); // 100 - 20
      expect(round?.stamina?.["lobster-b"]).toBe(85); // 100 - 15
    });

    it("guard recovers 10 stamina (capped at 100)", () => {
      const { battle } = startNearby(manager);

      // Turn 1: both strike (spend 20 each -> 80 stamina)
      manager.submitIntent("lobster-a", battle.battleId, "strike", 1100);
      manager.submitIntent("lobster-b", battle.battleId, "strike", 1200);

      // Turn 2: both guard (recover 10 each -> 90 stamina)
      manager.submitIntent("lobster-a", battle.battleId, "guard", 1300);
      const result = manager.submitIntent("lobster-b", battle.battleId, "guard", 1400);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      expect(round?.stamina?.["lobster-a"]).toBe(90);
      expect(round?.stamina?.["lobster-b"]).toBe(90);
    });

    it("guard does not exceed 100 stamina", () => {
      const { battle } = startNearby(manager);

      // Turn 1: both guard at full stamina
      manager.submitIntent("lobster-a", battle.battleId, "guard", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "guard", 1200);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      expect(round?.stamina?.["lobster-a"]).toBe(100);
      expect(round?.stamina?.["lobster-b"]).toBe(100);
    });

    it("downgrades intent to guard when stamina insufficient", () => {
      const { battle } = startNearby(manager);
      const battleId = battle.battleId;

      // Drain stamina: 5 strikes = 100 stamina spent
      for (let i = 0; i < 5; i++) {
        manager.submitIntent("lobster-a", battleId, "strike", 1100 + i * 100);
        manager.submitIntent("lobster-b", battleId, "guard", 1150 + i * 100);
      }

      // lobster-a is now at 0 stamina, attempt strike -> forced guard
      const result = manager.submitIntent("lobster-a", battleId, "strike", 2100);
      if (!result.ok) throw new Error(result.error);
      expect(result.events[0].intent).toBe("guard");
      expect(result.events[0].summary).toMatch(/lacked stamina/);
    });

    it("approach costs 5 and retreat costs 10 stamina", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "approach", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "approach", 1200);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      expect(round?.stamina?.["lobster-a"]).toBe(95); // 100 - 5
      expect(round?.stamina?.["lobster-b"]).toBe(95);
    });
  });

  // ── Rebalanced damage matrix ──────────────────────────────────

  describe("Rebalanced damage matrix", () => {
    it("guard halves feint damage (10 instead of 20)", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "feint", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "guard", 1200);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      // feint vs guard = 10 damage to b
      expect(round?.damage?.["lobster-b"]).toBe(10);
      // guard deals 0
      expect(round?.damage?.["lobster-a"]).toBe(0);
    });

    it("strike vs strike deals 18 (not 22)", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "strike", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "strike", 1200);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      expect(round?.damage?.["lobster-a"]).toBe(18);
      expect(round?.damage?.["lobster-b"]).toBe(18);
    });

    it("approach vs retreat deals 12 (not 8)", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "approach", 1100);
      // Note: retreat ends battle, but damage is calculated first
      const result = manager.submitIntent("lobster-b", battle.battleId, "retreat", 1200);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      // approach vs retreat = 12 damage to b
      expect(round?.damage?.["lobster-b"]).toBe(12);
    });

    it("preserves strike vs guard = 10", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "strike", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "guard", 1200);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      expect(round?.damage?.["lobster-b"]).toBe(10);
    });

    it("preserves strike vs feint = 28", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "strike", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "feint", 1200);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      expect(round?.damage?.["lobster-b"]).toBe(28);
    });
  });

  // ── Battle timeout ────────────────────────────────────────────

  describe("Battle timeout", () => {
    it("auto-resolves with guard after 30 seconds", () => {
      const startTs = 1000;
      startNearby(manager, startTs);

      // One agent submits, the other doesn't
      manager.submitIntent("lobster-a", "battle-1", "strike", startTs + 1000);

      // Not timed out yet at 29.9s
      expect(manager.checkTimeouts(startTs + 29_999)).toHaveLength(0);

      // Timed out at 31s — should auto-guard lobster-b and resolve
      const events = manager.checkTimeouts(startTs + 31_000);
      expect(events.length).toBeGreaterThanOrEqual(2);

      const timeoutEvent = events.find((ev) => ev.timedOut);
      expect(timeoutEvent?.timedOut).toEqual(["lobster-b"]);

      const round = events.find((ev) => ev.phase === "round");
      expect(round).toBeTruthy();
    });

    it("does not timeout before 30 seconds", () => {
      startNearby(manager, 1000);
      const events = manager.checkTimeouts(30_999);
      expect(events).toHaveLength(0);
    });

    it("auto-guards both agents if neither submitted", () => {
      startNearby(manager, 1000);
      const events = manager.checkTimeouts(31_001);
      expect(events.length).toBeGreaterThanOrEqual(2);

      const timeoutEvent = events.find((ev) => ev.timedOut);
      expect(timeoutEvent?.timedOut).toEqual(
        expect.arrayContaining(["lobster-a", "lobster-b"]),
      );
    });
  });

  // ── Momentum read bonus ───────────────────────────────────────

  describe("Momentum read bonus", () => {
    it("awards +5 damage when opponent repeats intent", () => {
      const { battle } = startNearby(manager);
      const battleId = battle.battleId;

      // Turn 1: A strikes, B guards
      manager.submitIntent("lobster-a", battleId, "strike", 1100);
      manager.submitIntent("lobster-b", battleId, "guard", 1200);

      // Turn 2: A strikes again, B guards again (both repeat)
      manager.submitIntent("lobster-a", battleId, "strike", 1300);
      const result = manager.submitIntent("lobster-b", battleId, "guard", 1400);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      // A reads B's guard repeat -> +5 to A's attack
      // strike vs guard = 10, + 5 read = 15 damage to B
      expect(round?.damage?.["lobster-b"]).toBe(15);
      expect(round?.readBonus?.["lobster-a"]).toBe(5);
    });

    it("does not award read bonus on first turn", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "strike", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "guard", 1200);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      expect(round?.readBonus).toBeUndefined();
      expect(round?.damage?.["lobster-b"]).toBe(10); // no bonus
    });

    it("does not award read bonus when opponent changes intent", () => {
      const { battle } = startNearby(manager);
      const battleId = battle.battleId;

      // Turn 1: A strikes, B guards
      manager.submitIntent("lobster-a", battleId, "strike", 1100);
      manager.submitIntent("lobster-b", battleId, "guard", 1200);

      // Turn 2: A feints (changed), B strikes (changed)
      manager.submitIntent("lobster-a", battleId, "feint", 1300);
      const result = manager.submitIntent("lobster-b", battleId, "strike", 1400);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      expect(round?.readBonus).toBeUndefined();
    });

    it("read bonus does not create damage from 0 base", () => {
      const { battle } = startNearby(manager);
      const battleId = battle.battleId;

      // Turn 1: both guard
      manager.submitIntent("lobster-a", battleId, "guard", 1100);
      manager.submitIntent("lobster-b", battleId, "guard", 1200);

      // Turn 2: both guard again (repeat, but guard deals 0)
      manager.submitIntent("lobster-a", battleId, "guard", 1300);
      const result = manager.submitIntent("lobster-b", battleId, "guard", 1400);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      // Guard deals 0 base, read bonus should NOT make it 5
      expect(round?.damage?.["lobster-a"]).toBe(0);
      expect(round?.damage?.["lobster-b"]).toBe(0);
    });
  });

  // ── Flee (retreat) mechanic ────────────────────────────────────

  describe("Flee mechanic", () => {
    it("retreat ends battle with no winner or loser", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "strike", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "retreat", 1200);
      if (!result.ok) throw new Error(result.error);

      const ended = result.events.find((ev) => ev.phase === "ended");
      expect(ended).toBeTruthy();
      expect(ended?.reason).toBe("flee");
      expect(ended?.winnerId).toBeUndefined();
      expect(ended?.loserId).toBeUndefined();
      expect(ended?.defeatedIds).toBeUndefined();
      expect(manager.isInBattle("lobster-a")).toBe(false);
      expect(manager.isInBattle("lobster-b")).toBe(false);
    });

    it("fleeing agent still takes damage from opponent's attack", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "strike", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "retreat", 1200);
      if (!result.ok) throw new Error(result.error);

      const round = result.events.find((ev) => ev.phase === "round");
      // strike vs retreat = 30 damage to retreater
      expect(round?.damage?.["lobster-b"]).toBe(30);
      // retreat deals 0 damage
      expect(round?.damage?.["lobster-a"]).toBe(0);
    });

    it("both retreat = draw with no winner", () => {
      const { battle } = startNearby(manager);
      manager.submitIntent("lobster-a", battle.battleId, "retreat", 1100);
      const result = manager.submitIntent("lobster-b", battle.battleId, "retreat", 1200);
      if (!result.ok) throw new Error(result.error);

      const ended = result.events.find((ev) => ev.phase === "ended");
      expect(ended?.reason).toBe("draw");
      expect(ended?.winnerId).toBeUndefined();
    });
  });

  // ── Truce system ───────────────────────────────────────────────

  describe("Truce system", () => {
    it("one-sided truce proposal does not end battle", () => {
      const { battle } = startNearby(manager);
      const result = manager.proposeTruce("lobster-a", battle.battleId, 1100);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.accepted).toBe(false);
      expect(result.battle).toBeTruthy();
      expect(manager.isInBattle("lobster-a")).toBe(true);
    });

    it("mutual truce ends battle peacefully", () => {
      const { battle } = startNearby(manager);
      manager.proposeTruce("lobster-a", battle.battleId, 1100);
      const result = manager.proposeTruce("lobster-b", battle.battleId, 1200);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.accepted).toBe(true);
      expect(result.battle).toBeNull();

      const ended = result.events.find((ev) => ev.phase === "ended");
      expect(ended?.reason).toBe("truce");
      expect(ended?.winnerId).toBeUndefined();
      expect(ended?.loserId).toBeUndefined();
      expect(manager.isInBattle("lobster-a")).toBe(false);
      expect(manager.isInBattle("lobster-b")).toBe(false);
    });

    it("rejects duplicate truce proposal from same agent", () => {
      const { battle } = startNearby(manager);
      manager.proposeTruce("lobster-a", battle.battleId, 1100);
      const result = manager.proposeTruce("lobster-a", battle.battleId, 1200);
      expect(result.ok).toBe(false);
    });

    it("truce proposal persists across turns", () => {
      const { battle } = startNearby(manager);
      const battleId = battle.battleId;

      // Agent A proposes truce
      manager.proposeTruce("lobster-a", battleId, 1100);

      // Play a full turn
      manager.submitIntent("lobster-a", battleId, "guard", 1200);
      manager.submitIntent("lobster-b", battleId, "guard", 1300);

      // Agent B accepts truce next turn — should still work
      const result = manager.proposeTruce("lobster-b", battleId, 1400);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.accepted).toBe(true);
      expect(manager.isInBattle("lobster-a")).toBe(false);
    });
  });
});
