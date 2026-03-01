import { describe, it, expect, beforeEach } from "vitest";
import { CommandQueue } from "../command-queue.js";
import type { WorldMessage } from "../types.js";

function makeMove(agentId: string, x: number, z: number): WorldMessage {
  return { worldType: "position", agentId, x, y: 0, z, rotation: 0, timestamp: Date.now() };
}

function makeChat(agentId: string, text: string): WorldMessage {
  return { worldType: "chat", agentId, text, timestamp: Date.now() };
}

describe("CommandQueue", () => {
  let queue: CommandQueue;

  beforeEach(() => {
    queue = new CommandQueue();
  });

  describe("enqueue & drain", () => {
    it("enqueues and drains commands", () => {
      const msg = makeMove("a1", 5, 5);
      const result = queue.enqueue(msg);
      expect(result.ok).toBe(true);

      const drained = queue.drain();
      expect(drained).toHaveLength(1);
      expect(drained[0]).toBe(msg);
    });

    it("drains empty queue", () => {
      expect(queue.drain()).toHaveLength(0);
    });

    it("drain clears the queue", () => {
      queue.enqueue(makeMove("a1", 0, 0));
      queue.drain();
      expect(queue.drain()).toHaveLength(0);
    });
  });

  describe("bounds check", () => {
    it("rejects non-finite position payload", () => {
      const badMove = makeMove("a1", Number.NaN, 0);
      const result = queue.enqueue(badMove);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("invalid_position");
    });

    it("rejects out-of-bounds x", () => {
      const result = queue.enqueue(makeMove("a1", 160, 0));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("out_of_bounds");
    });

    it("rejects out-of-bounds z", () => {
      const result = queue.enqueue(makeMove("a1", 0, -160));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("out_of_bounds");
    });

    it("allows position at boundary", () => {
      const result = queue.enqueue(makeMove("a1", 150, -150));
      expect(result.ok).toBe(true);
    });
  });

  describe("obstacle collision", () => {
    it("rejects move that collides with obstacle", () => {
      queue.setObstacles([{ x: 10, z: 10, radius: 3 }]);
      const result = queue.enqueue(makeMove("a1", 10, 10));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("collision");
    });

    it("allows move far from obstacle", () => {
      queue.setObstacles([{ x: 10, z: 10, radius: 3 }]);
      const result = queue.enqueue(makeMove("a1", 30, 30));
      expect(result.ok).toBe(true);
    });
  });

  describe("chat validation", () => {
    it("allows short chat message", () => {
      const result = queue.enqueue(makeChat("a1", "hello"));
      expect(result.ok).toBe(true);
    });

    it("rejects chat message over 500 chars", () => {
      const longText = "a".repeat(501);
      const result = queue.enqueue(makeChat("a1", longText));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("text_too_long");
    });

    it("allows chat message at exactly 500 chars", () => {
      const text = "a".repeat(500);
      const result = queue.enqueue(makeChat("a1", text));
      expect(result.ok).toBe(true);
    });

    it("rejects invalid timestamp payloads", () => {
      const invalidTs = {
        worldType: "chat",
        agentId: "a1",
        text: "hello",
        timestamp: Number.NaN,
      } as unknown as WorldMessage;
      const result = queue.enqueue(invalidTs);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("invalid_timestamp");
    });
  });

  describe("rate limiting", () => {
    it("allows up to 20 commands per second", () => {
      for (let i = 0; i < 20; i++) {
        const result = queue.enqueue(makeMove("a1", i, 0));
        expect(result.ok).toBe(true);
      }
    });

    it("rejects the 21st command within rate window", () => {
      for (let i = 0; i < 20; i++) {
        queue.enqueue(makeMove("a1", i, 0));
      }
      const result = queue.enqueue(makeMove("a1", 0, 0));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("rate_limited");
    });

    it("rate limits per agent", () => {
      for (let i = 0; i < 20; i++) {
        queue.enqueue(makeMove("a1", i, 0));
      }
      // Different agent should not be rate limited
      const result = queue.enqueue(makeMove("a2", 0, 0));
      expect(result.ok).toBe(true);
    });
  });

  describe("queue capacity", () => {
    it("rejects commands after queue reaches max capacity", () => {
      for (let i = 0; i < 10_000; i++) {
        const result = queue.enqueue({
          worldType: "leave",
          agentId: `a${i}`,
          timestamp: Date.now(),
        });
        expect(result.ok).toBe(true);
      }
      const overflow = queue.enqueue({
        worldType: "leave",
        agentId: "overflow-agent",
        timestamp: Date.now(),
      });
      expect(overflow.ok).toBe(false);
      expect(overflow.reason).toBe("queue_full");
    });
  });
});
