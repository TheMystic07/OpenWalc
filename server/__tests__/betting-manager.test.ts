import { beforeEach, describe, expect, it } from "vitest";
import { BettingManager } from "../betting-manager.js";

describe("BettingManager", () => {
  let manager: BettingManager;

  beforeEach(() => {
    manager = new BettingManager({ minBet: 1, walletAddress: "admin-wallet-123" });
  });

  it("places a bet", () => {
    const result = manager.placeBet("wallet-a", "agent-1", 10, "tx-hash-1");
    expect(result.ok).toBe(true);
  });

  it("rejects bet below minimum", () => {
    const result = manager.placeBet("wallet-a", "agent-1", 0.5, "tx-hash-1");
    expect(result.ok).toBe(false);
  });

  it("calculates implied odds", () => {
    manager.placeBet("wallet-a", "agent-1", 100, "tx-1");
    manager.placeBet("wallet-b", "agent-2", 50, "tx-2");
    const odds = manager.getOdds();
    expect(odds.get("agent-1")).toBeCloseTo(1.5, 1);
    expect(odds.get("agent-2")).toBeCloseTo(3, 1);
  });

  it("calculates payouts for winning agent", () => {
    manager.placeBet("wallet-a", "agent-1", 100, "tx-1");
    manager.placeBet("wallet-b", "agent-1", 50, "tx-2");
    manager.placeBet("wallet-c", "agent-2", 200, "tx-3");

    const payouts = manager.resolve("agent-1");
    expect(payouts).toHaveLength(2);

    const payoutA = payouts.find((entry) => entry.wallet === "wallet-a");
    const payoutB = payouts.find((entry) => entry.wallet === "wallet-b");
    expect(payoutA?.amount).toBeCloseTo(233.33, 1);
    expect(payoutB?.amount).toBeCloseTo(116.67, 1);
  });

  it("returns empty payouts if nobody bet on winner", () => {
    manager.placeBet("wallet-a", "agent-1", 100, "tx-1");
    expect(manager.resolve("agent-2")).toHaveLength(0);
  });

  it("returns total pool size", () => {
    manager.placeBet("wallet-a", "agent-1", 100, "tx-1");
    manager.placeBet("wallet-b", "agent-2", 50, "tx-2");
    expect(manager.getTotalPool()).toBe(150);
  });

  it("closes betting", () => {
    manager.closeBetting();
    const result = manager.placeBet("wallet-a", "agent-1", 100, "tx-1");
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate transaction hashes", () => {
    manager.placeBet("wallet-a", "agent-1", 100, "tx-1");
    const duplicate = manager.placeBet("wallet-b", "agent-2", 100, "tx-1");
    expect(duplicate.ok).toBe(false);
  });

  it("normalizes txHash before duplicate checks", () => {
    manager.placeBet("wallet-a", "agent-1", 100, " tx-1 ");
    const duplicate = manager.placeBet("wallet-b", "agent-2", 100, "tx-1");
    expect(duplicate.ok).toBe(false);
  });

  it("removes a bet by txHash even with surrounding spaces", () => {
    manager.placeBet("wallet-a", "agent-1", 100, "tx-1");
    manager.removeBetByTxHash(" tx-1 ");
    expect(manager.getTotalPool()).toBe(0);
  });

  it("resets for new round", () => {
    manager.placeBet("wallet-a", "agent-1", 100, "tx-1");
    manager.reset();
    expect(manager.getTotalPool()).toBe(0);
    expect(manager.isClosed()).toBe(false);
  });

  it("returns admin wallet address", () => {
    expect(manager.getWalletAddress()).toBe("admin-wallet-123");
  });

  it("generates payout report", () => {
    manager.placeBet("wallet-a", "agent-1", 100, "tx-1");
    manager.placeBet("wallet-b", "agent-2", 50, "tx-2");
    const report = manager.generatePayoutReport("agent-1");
    expect(report.winner).toBe("agent-1");
    expect(report.totalPool).toBe(150);
    expect(report.adminWallet).toBe("admin-wallet-123");
    expect(report.payouts).toHaveLength(1);
    expect(report.payouts[0].wallet).toBe("wallet-a");
    expect(report.payouts[0].amount).toBe(150);
  });
});
