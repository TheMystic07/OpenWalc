import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameLoop } from "../game-loop.js";
import type { ClientManager } from "../client-manager.js";
import type { CommandQueue } from "../command-queue.js";
import type { NostrWorld } from "../nostr-world.js";
import type { SpatialGrid } from "../spatial-index.js";
import type { WorldMessage } from "../types.js";
import type { WorldState } from "../world-state.js";

function makeChat(agentId: string): WorldMessage {
  return {
    worldType: "chat",
    agentId,
    text: `hello-${agentId}`,
    timestamp: Date.now(),
  };
}

function runPrivateTick(loop: GameLoop): void {
  (loop as unknown as { tick: () => void }).tick();
}

function createLoop(commands: WorldMessage[], applyImpl?: (msg: WorldMessage) => void) {
  const worldState = {
    apply: vi.fn((msg: WorldMessage) => {
      applyImpl?.(msg);
    }),
    getAllPositions: vi.fn(() => new Map()),
    getPosition: vi.fn(() => undefined),
    snapshot: vi.fn(() => []),
  } as unknown as WorldState;

  const spatialGrid = {
    rebuild: vi.fn(),
    queryRadius: vi.fn(() => new Set<string>()),
  } as unknown as SpatialGrid;

  const commandQueue = {
    drain: vi.fn(() => commands),
    pruneAgent: vi.fn(),
  } as unknown as CommandQueue;

  const clientManager = {
    getAllClients: vi.fn(() => []),
  } as unknown as ClientManager;

  const nostr = {
    publish: vi.fn(() => Promise.resolve()),
  } as unknown as NostrWorld;

  const loop = new GameLoop(worldState, spatialGrid, commandQueue, clientManager, nostr);
  return { loop, worldState, spatialGrid, commandQueue, clientManager, nostr };
}

describe("GameLoop hardening", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("keeps processing commands even when a tick hook throws", () => {
    const { loop, worldState } = createLoop([makeChat("agent-a")]);
    loop.onTick(() => {
      throw new Error("tick hook failed");
    });

    runPrivateTick(loop);
    expect(worldState.apply).toHaveBeenCalledTimes(1);
  });

  it("runs all event hooks even when one hook throws", () => {
    const { loop } = createLoop([makeChat("agent-a")]);
    const seenEventLengths: number[] = [];
    loop.onEvents(() => {
      throw new Error("event hook failed");
    });
    loop.onEvents((events) => {
      seenEventLengths.push(events.length);
    });

    runPrivateTick(loop);
    expect(seenEventLengths).toEqual([1]);
  });

  it("skips only the failing command and processes the rest", () => {
    const { loop, worldState, nostr } = createLoop(
      [makeChat("bad-agent"), makeChat("good-agent")],
      (msg) => {
        if (msg.agentId === "bad-agent") {
          throw new Error("corrupt command");
        }
      },
    );
    const seenEventLengths: number[] = [];
    loop.onEvents((events) => {
      seenEventLengths.push(events.length);
    });

    runPrivateTick(loop);
    expect(worldState.apply).toHaveBeenCalledTimes(2);
    expect(nostr.publish).toHaveBeenCalledTimes(1);
    expect(seenEventLengths).toEqual([1]);
  });
});
