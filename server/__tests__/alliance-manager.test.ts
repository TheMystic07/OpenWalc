import { beforeEach, describe, expect, it } from "vitest";
import { AllianceManager } from "../alliance-manager.js";

describe("AllianceManager", () => {
  let manager: AllianceManager;

  beforeEach(() => {
    manager = new AllianceManager();
  });

  it("proposes alliance", () => {
    const result = manager.propose("agent-1", "agent-2");
    expect(result.ok).toBe(true);
  });

  it("accepts alliance proposal", () => {
    manager.propose("agent-1", "agent-2", 1_000);
    const result = manager.accept("agent-2", "agent-1", 1_001);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alliance.members).toContain("agent-1");
    expect(result.alliance.members).toContain("agent-2");
  });

  it("declines alliance proposal", () => {
    manager.propose("agent-1", "agent-2");
    const result = manager.decline("agent-2", "agent-1");
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate proposals", () => {
    manager.propose("agent-1", "agent-2");
    const result = manager.propose("agent-1", "agent-2");
    expect(result.ok).toBe(false);
  });

  it("prevents alliance with self", () => {
    const result = manager.propose("agent-1", "agent-1");
    expect(result.ok).toBe(false);
  });

  it("breaks alliance", () => {
    manager.propose("agent-1", "agent-2", 1_000);
    manager.accept("agent-2", "agent-1", 1_001);
    const result = manager.breakAlliance("agent-1");
    expect(result.ok).toBe(true);
    expect(manager.getAlliance("agent-1")).toBeNull();
  });

  it("detects betrayal when breaking alliance", () => {
    manager.propose("agent-1", "agent-2", 1_000);
    manager.accept("agent-2", "agent-1", 1_001);
    const result = manager.breakAlliance("agent-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.betrayal).toBe(true);
    expect(result.formerAllies).toContain("agent-2");
  });

  it("checks if two agents are allies", () => {
    manager.propose("agent-1", "agent-2", 1_000);
    manager.accept("agent-2", "agent-1", 1_001);
    expect(manager.areAllies("agent-1", "agent-2")).toBe(true);
    expect(manager.areAllies("agent-1", "agent-3")).toBe(false);
  });

  it("enforces max alliance size", () => {
    manager.setMaxSize(2);
    manager.propose("agent-1", "agent-2", 1_000);
    manager.accept("agent-2", "agent-1", 1_001);

    manager.propose("agent-1", "agent-3", 1_100);
    const result = manager.accept("agent-3", "agent-1", 1_101);
    expect(result.ok).toBe(false);
  });

  it("expires proposals after timeout", () => {
    manager.propose("agent-1", "agent-2", 1_000);
    manager.expireProposals(1_000 + 30_000 + 1);
    const result = manager.accept("agent-2", "agent-1", 1_000 + 30_000 + 2);
    expect(result.ok).toBe(false);
  });

  it("removes agent from alliance on leave", () => {
    manager.propose("agent-1", "agent-2", 1_000);
    manager.accept("agent-2", "agent-1", 1_001);
    manager.removeAgent("agent-1");
    expect(manager.getAlliance("agent-1")).toBeNull();
    expect(manager.getAlliance("agent-2")).toBeNull();
  });

  it("returns all alliances", () => {
    manager.propose("a1", "a2", 1_000);
    manager.accept("a2", "a1", 1_001);
    manager.propose("a3", "a4", 1_100);
    manager.accept("a4", "a3", 1_101);

    expect(manager.getAllAlliances()).toHaveLength(2);
  });

  it("blocks alliance proposals for ruthless agents (guilt > 5)", () => {
    const result = manager.propose("agent-1", "agent-2", 1_000, 6);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ruthless");
  });
});
