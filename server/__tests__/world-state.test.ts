import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../agent-registry.js";
import { WorldState } from "../world-state.js";
import { WORLD_SIZE, type JoinMessage } from "../types.js";

function makeJoin(
  agentId: string,
  overrides: Partial<JoinMessage> = {},
): JoinMessage {
  return {
    worldType: "join",
    agentId,
    name: agentId,
    walletAddress: "0xtestwallet123",
    color: "#ff6f61",
    bio: "",
    capabilities: ["explore"],
    timestamp: 1000,
    ...overrides,
  };
}

describe("WorldState join spawn handling", () => {
  it("uses explicit join spawn coordinates when provided", () => {
    const state = new WorldState(new AgentRegistry());
    state.apply(makeJoin("a1", { x: 12, y: 0, z: -8, rotation: 1.25 }));

    const pos = state.getPosition("a1");
    expect(pos).toBeDefined();
    expect(pos?.x).toBe(12);
    expect(pos?.y).toBe(0);
    expect(pos?.z).toBe(-8);
    expect(pos?.rotation).toBe(1.25);
  });

  it("generates spawn within central town-square radius", () => {
    const state = new WorldState(new AgentRegistry());
    state.apply(makeJoin("a2"));

    const pos = state.getPosition("a2");
    expect(pos).toBeDefined();
    // Agents should spawn within ~35-unit radius of center (town square)
    const dist = Math.sqrt(pos!.x * pos!.x + pos!.z * pos!.z);
    expect(dist).toBeLessThanOrEqual(40); // small margin for fallback
    expect(pos?.y).toBe(0);
  });

  it("does not overwrite existing position on repeated join", () => {
    const state = new WorldState(new AgentRegistry());
    state.apply(makeJoin("a3", { x: 5, y: 0, z: 7, rotation: 2.2, timestamp: 1000 }));
    state.apply(makeJoin("a3", { x: -90, y: 0, z: -90, rotation: 0.2, timestamp: 2000 }));

    const pos = state.getPosition("a3");
    expect(pos).toBeDefined();
    expect(pos?.x).toBe(5);
    expect(pos?.z).toBe(7);
    expect(pos?.rotation).toBe(2.2);
  });
});
