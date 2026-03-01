import { describe, expect, it } from "vitest";
import { parseFollowPayload, parsePlaceBetPayload, parseViewportPayload } from "../ws-bridge.js";

describe("WSBridge payload parsing", () => {
  it("accepts a valid viewport payload", () => {
    const parsed = parseViewportPayload({ x: 12.5, z: -33.2 });
    expect(parsed).toEqual({ x: 12.5, z: -33.2 });
  });

  it("rejects non-finite viewport payload", () => {
    const parsed = parseViewportPayload({ x: Number.NaN, z: 1 });
    expect(parsed).toBeNull();
  });

  it("accepts a trimmed follow payload", () => {
    const parsed = parseFollowPayload({ agentId: "  alpha-1 " });
    expect(parsed).toEqual({ agentId: "alpha-1" });
  });

  it("rejects invalid follow payload", () => {
    const parsed = parseFollowPayload({ agentId: "   " });
    expect(parsed).toBeNull();
  });

  it("accepts a normalized place bet payload", () => {
    const parsed = parsePlaceBetPayload({
      agentId: "  alpha-1 ",
      amount: 10,
      txHash: " 4SigaTureExamplE ",
      wallet: " WalletExample111111111111111111111111111 ",
    });
    expect(parsed).toEqual({
      agentId: "alpha-1",
      amount: 10,
      txHash: "4SigaTureExamplE",
      wallet: "WalletExample111111111111111111111111111",
    });
  });

  it("rejects place bet payload with invalid amount", () => {
    const parsed = parsePlaceBetPayload({
      agentId: "alpha-1",
      amount: 0,
      txHash: "4SigaTureExamplE",
      wallet: "WalletExample111111111111111111111111111",
    });
    expect(parsed).toBeNull();
  });

  it("rejects place bet payload with whitespace inside txHash", () => {
    const parsed = parsePlaceBetPayload({
      agentId: "alpha-1",
      amount: 10,
      txHash: "bad tx hash",
      wallet: "WalletExample111111111111111111111111111",
    });
    expect(parsed).toBeNull();
  });
});
