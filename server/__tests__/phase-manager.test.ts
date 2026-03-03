import { beforeEach, describe, expect, it } from "vitest";
import { PhaseManager } from "../phase-manager.js";

const HOUR_MS = 60 * 60 * 1000;

describe("PhaseManager", () => {
  let manager: PhaseManager;

  beforeEach(() => {
    manager = new PhaseManager({
      lobbyHours: 48,
      battleHours: 72,
      showdownHours: 48,
      zoneShrinkIntervalHours: 4,
      zoneFinalRadius: 30,
      worldRadius: 150,
    });
  });

  it("starts in lobby phase", () => {
    expect(manager.getPhase()).toBe("lobby");
  });

  it("transitions lobby -> battle after lobby duration", () => {
    const startedAt = 1_000_000;
    const events: string[] = [];
    manager.onPhaseChange((phase) => events.push(phase));

    manager.startRound(startedAt);
    manager.tick(startedAt + 48 * HOUR_MS + 1);

    expect(manager.getPhase()).toBe("battle");
    expect(events).toContain("battle");
  });

  it("transitions battle -> showdown", () => {
    const startedAt = 1_000_000;
    manager.startRound(startedAt);
    manager.tick(startedAt + 48 * HOUR_MS + 1);
    manager.tick(startedAt + (48 + 72) * HOUR_MS + 1);
    expect(manager.getPhase()).toBe("showdown");
  });

  it("shrinks safe zone during showdown", () => {
    const startedAt = 1_000_000;
    manager.startRound(startedAt);
    const showdownStart = startedAt + (48 + 72) * HOUR_MS + 1;

    manager.tick(showdownStart);
    expect(manager.getPhase()).toBe("showdown");
    expect(manager.getSafeZoneRadius()).toBe(150);

    manager.tick(showdownStart + 4 * HOUR_MS);
    expect(manager.getSafeZoneRadius()).toBeLessThan(150);
    expect(manager.getSafeZoneRadius()).toBeGreaterThanOrEqual(30);
  });

  it("rejects combat in lobby", () => {
    manager.startRound(1_000_000);
    expect(manager.isCombatAllowed()).toBe(false);
  });

  it("allows combat in battle phase", () => {
    const startedAt = 1_000_000;
    manager.startRound(startedAt);
    manager.tick(startedAt + 48 * HOUR_MS + 1);
    expect(manager.isCombatAllowed()).toBe(true);
  });

  it("returns correct phase state", () => {
    manager.startRound(1_000_000);
    const state = manager.getState();
    expect(state.phase).toBe("lobby");
    expect(state.roundNumber).toBe(1);
    expect(state.safeZoneRadius).toBe(150);
  });

  it("ends round explicitly", () => {
    manager.startRound(1_000_000);
    manager.endRound("agent-1");
    expect(manager.getPhase()).toBe("ended");
    expect(manager.getWinnerId()).toBe("agent-1");
  });

  it("resets back to lobby", () => {
    manager.startRound(1_000_000);
    manager.endRound("agent-1");
    manager.reset();
    expect(manager.getPhase()).toBe("lobby");
    expect(manager.getRoundNumber()).toBe(1);
  });

  it("alliance max size is 4 in battle and 2 in showdown", () => {
    const startedAt = 1_000_000;
    manager.startRound(startedAt);

    manager.tick(startedAt + 48 * HOUR_MS + 1);
    expect(manager.getAllianceMaxSize()).toBe(4);

    manager.tick(startedAt + (48 + 72) * HOUR_MS + 1);
    expect(manager.getAllianceMaxSize()).toBe(2);
  });

  it("supports custom per-round phase timelines", () => {
    const startedAt = 1_000_000;
    manager.startRound(startedAt, {
      lobbyMs: 5_000,
      battleMs: 10_000,
      showdownMs: 5_000,
    });

    manager.tick(startedAt + 5_001);
    expect(manager.getPhase()).toBe("battle");

    manager.tick(startedAt + 15_001);
    expect(manager.getPhase()).toBe("showdown");

    manager.tick(startedAt + 20_001);
    expect(manager.getPhase()).toBe("ended");
  });

  it("restores phase timeline + round metadata", () => {
    const startedAt = 2_000_000;
    manager.restore({
      phase: "battle",
      startedAt,
      roundNumber: 7,
      timelineMs: {
        lobbyMs: 1_000,
        battleMs: 1_000,
        showdownMs: 1_000,
      },
    });

    expect(manager.getPhase()).toBe("battle");
    expect(manager.getRoundNumber()).toBe(7);
    manager.tick(startedAt + 2_001);
    expect(manager.getPhase()).toBe("showdown");
  });
});
