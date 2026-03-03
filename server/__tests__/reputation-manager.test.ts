import { beforeEach, describe, expect, it } from "vitest";
import { ReputationManager } from "../reputation-manager.js";

describe("ReputationManager", () => {
  let manager: ReputationManager;

  beforeEach(() => {
    manager = new ReputationManager();
  });

  it("initializes reputation at 5", () => {
    expect(manager.getReputation("agent-1")).toBe(5);
  });

  it("decreases reputation on betrayal", () => {
    manager.recordBetrayal("agent-1");
    expect(manager.getReputation("agent-1")).toBe(3);
  });

  it("clamps reputation at 0", () => {
    manager.recordBetrayal("agent-1");
    manager.recordBetrayal("agent-1");
    manager.recordBetrayal("agent-1");
    expect(manager.getReputation("agent-1")).toBe(0);
  });

  it("increases reputation for alliance loyalty", () => {
    manager.recordAllianceDay("agent-1");
    expect(manager.getReputation("agent-1")).toBe(5.5);
  });

  it("clamps reputation at 10", () => {
    for (let i = 0; i < 20; i += 1) {
      manager.recordAllianceDay("agent-1");
    }
    expect(manager.getReputation("agent-1")).toBe(10);
  });

  it("returns all reputations", () => {
    manager.getReputation("agent-1");
    manager.getReputation("agent-2");
    expect(manager.getAll()).toHaveLength(2);
  });

  it("can set reputation directly", () => {
    manager.setReputation("agent-1", 9.5);
    expect(manager.getReputation("agent-1")).toBe(9.5);
  });
});
