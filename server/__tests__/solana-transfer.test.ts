import { describe, expect, it } from "vitest";
import { SolanaTransferService } from "../solana-transfer.js";

function createService() {
  return new SolanaTransferService({
    rpcUrl: "http://127.0.0.1:8899",
    adminWallet: "admin-wallet",
  });
}

function mockParsedTransaction(
  service: SolanaTransferService,
  parsedTransaction: unknown,
): void {
  const mutableService = service as unknown as {
    connection: {
      getParsedTransaction: (signature: string, options: unknown) => Promise<unknown>;
    };
  };
  mutableService.connection.getParsedTransaction = async () => parsedTransaction;
}

describe("SolanaTransferService.verifyIncomingTransfer", () => {
  it("accepts transfers when the resolved sender matches the expected wallet", async () => {
    const service = createService();
    mockParsedTransaction(service, {
      meta: {
        preBalances: [0, 2_000_000_000],
        postBalances: [0, 3_000_000_000],
      },
      slot: 42,
      blockTime: 123456,
      transaction: {
        message: {
          accountKeys: [
            { pubkey: "sender-wallet", signer: true },
            { pubkey: "admin-wallet", signer: false },
          ],
          instructions: [],
        },
      },
    });

    const result = await service.verifyIncomingTransfer({
      signature: "sig-1",
      expectedAmount: 1,
      expectedFromWallet: "sender-wallet",
    });

    expect(result).toEqual({
      ok: true,
      verifiedAmount: 1,
      fromWallet: "sender-wallet",
      toWallet: "admin-wallet",
      slot: 42,
      blockTime: 123456,
    });
  });

  it("rejects transfers when the sender wallet cannot be resolved", async () => {
    const service = createService();
    mockParsedTransaction(service, {
      meta: {
        preBalances: [2_000_000_000],
        postBalances: [3_000_000_000],
      },
      slot: 7,
      blockTime: 987654,
      transaction: {
        message: {
          accountKeys: [
            { pubkey: "admin-wallet", signer: false },
          ],
          instructions: [],
        },
      },
    });

    const result = await service.verifyIncomingTransfer({
      signature: "sig-2",
      expectedAmount: 1,
      expectedFromWallet: "sender-wallet",
    });

    expect(result).toEqual({
      ok: false,
      error: "sender_wallet_unresolved",
    });
  });
});
