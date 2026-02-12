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

describe("BattleManager", () => {
  let manager: BattleManager;

  beforeEach(() => {
    manager = new BattleManager();
  });

  it("starts a battle when agents are nearby", () => {
    const result = manager.startBattle(
      "lobster-a",
      "lobster-b",
      makePos("lobster-a", 0, 0),
      makePos("lobster-b", 3, 4),
      1000,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
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
      1000,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/too far/i);
  });

  it("resolves a round after both intents are submitted", () => {
    const started = manager.startBattle(
      "lobster-a",
      "lobster-b",
      makePos("lobster-a", 0, 0),
      makePos("lobster-b", 3, 3),
      1000,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const battleId = started.battle.battleId;

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
    const started = manager.startBattle(
      "lobster-a",
      "lobster-b",
      makePos("lobster-a", 0, 0),
      makePos("lobster-b", 2, 2),
      1000,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const result = manager.surrender("lobster-a", started.battle.battleId, 2000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0].phase).toBe("ended");
    expect(result.events[0].reason).toBe("surrender");
    expect(manager.isInBattle("lobster-a")).toBe(false);
    expect(manager.isInBattle("lobster-b")).toBe(false);
  });

  it("ends battle on disconnect with opponent as winner", () => {
    const started = manager.startBattle(
      "lobster-a",
      "lobster-b",
      makePos("lobster-a", 0, 0),
      makePos("lobster-b", 2, 1),
      1000,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const events = manager.handleAgentLeave("lobster-a", 3000);
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe("ended");
    expect(events[0].reason).toBe("disconnect");
    expect(events[0].winnerId).toBe("lobster-b");
  });

  it("marks defeated agent ids when battle ends by KO", () => {
    const started = manager.startBattle(
      "lobster-a",
      "lobster-b",
      makePos("lobster-a", 0, 0),
      makePos("lobster-b", 2, 1),
      1000,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const battleId = started.battle.battleId;
    let endedEvent: { phase: string; reason?: string; defeatedIds?: string[] } | null = null;

    for (let turn = 0; turn < 4; turn++) {
      const aIntent = manager.submitIntent("lobster-a", battleId, "strike", 1100 + turn * 10);
      expect(aIntent.ok).toBe(true);
      if (!aIntent.ok) return;

      const bIntent = manager.submitIntent("lobster-b", battleId, "feint", 1105 + turn * 10);
      expect(bIntent.ok).toBe(true);
      if (!bIntent.ok) return;

      endedEvent = bIntent.events.find((ev) => ev.phase === "ended") ?? endedEvent;
      if (endedEvent) break;
    }

    expect(endedEvent).toBeTruthy();
    if (!endedEvent) return;
    expect(endedEvent.reason).toBe("ko");
    expect(endedEvent.defeatedIds).toEqual(["lobster-b"]);
  });
});
