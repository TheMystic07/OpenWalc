import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

export interface SolanaTransferConfig {
  rpcUrl: string;
  adminWallet: string;
  adminSecretKeyJson?: string;
}

export interface VerifyTransferInput {
  signature: string;
  expectedAmount?: number;
  expectedFromWallet?: string;
}

export type VerifyTransferResult =
  | {
      ok: true;
      verifiedAmount: number;
      fromWallet: string | null;
      toWallet: string;
      slot: number | null;
      blockTime: number | null;
    }
  | { ok: false; error: string };

export type SendPayoutResult =
  | { ok: true; signature: string }
  | { ok: false; error: string };

export class SolanaTransferService {
  private readonly connection: Connection;
  private readonly adminWallet: string;
  private readonly adminSigner: Keypair | null;

  constructor(config: SolanaTransferConfig) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.adminWallet = config.adminWallet;
    this.adminSigner = parseKeypair(config.adminSecretKeyJson) ?? null;
  }

  async verifyIncomingTransfer(input: VerifyTransferInput): Promise<VerifyTransferResult> {
    const signature = input.signature.trim();
    if (!signature) return { ok: false, error: "signature_required" };

    const tx = await this.connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) return { ok: false, error: "transaction_not_found" };

    const resolution = resolveSenderAndAdminIndex(tx, this.adminWallet);
    if (resolution.adminIndex < 0) {
      return { ok: false, error: "admin_wallet_not_in_transaction" };
    }

    const pre = tx.meta.preBalances?.[resolution.adminIndex];
    const post = tx.meta.postBalances?.[resolution.adminIndex];
    if (!Number.isFinite(pre) || !Number.isFinite(post)) {
      return { ok: false, error: "balance_metadata_unavailable" };
    }

    const deltaLamports = Math.round(post - pre);
    if (deltaLamports <= 0) {
      return { ok: false, error: "no_sol_received_by_admin_wallet" };
    }

    const verifiedAmount = deltaLamports / LAMPORTS_PER_SOL;
    if (input.expectedAmount !== undefined) {
      const expectedLamports = Math.round(Number(input.expectedAmount) * LAMPORTS_PER_SOL);
      if (!Number.isFinite(expectedLamports) || expectedLamports <= 0) {
        return { ok: false, error: "invalid_expected_amount" };
      }
      if (deltaLamports !== expectedLamports) {
        return {
          ok: false,
          error: `amount_mismatch_expected_${input.expectedAmount}_got_${verifiedAmount}`,
        };
      }
    }

    if (input.expectedFromWallet) {
      if (!resolution.senderWallet) {
        return { ok: false, error: "sender_wallet_unresolved" };
      }
      const expectedLower = input.expectedFromWallet.toLowerCase();
      if (resolution.senderWallet.toLowerCase() !== expectedLower) {
        return { ok: false, error: "sender_wallet_mismatch" };
      }
    }

    return {
      ok: true,
      verifiedAmount,
      fromWallet: resolution.senderWallet,
      toWallet: this.adminWallet,
      slot: tx.slot ?? null,
      blockTime: tx.blockTime ?? null,
    };
  }

  async sendPayout(toWallet: string, amount: number): Promise<SendPayoutResult> {
    if (!this.adminSigner) {
      return { ok: false, error: "admin_signer_not_configured" };
    }
    if (!toWallet) return { ok: false, error: "to_wallet_required" };
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "amount_must_be_positive" };
    }

    const lamports = Math.round(amount * LAMPORTS_PER_SOL);
    if (!Number.isSafeInteger(lamports) || lamports <= 0) {
      return { ok: false, error: "amount_invalid_for_sol_transfer" };
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.adminSigner.publicKey,
        toPubkey: new PublicKey(toWallet),
        lamports,
      }),
    );

    try {
      const signature = await sendAndConfirmTransaction(this.connection, tx, [this.adminSigner], {
        commitment: "confirmed",
      });
      return { ok: true, signature };
    } catch (error) {
      return { ok: false, error: `payout_failed:${String(error)}` };
    }
  }
}

function parseKeypair(secretKeyJson: string | undefined): Keypair | null {
  if (!secretKeyJson) return null;
  try {
    const parsed = JSON.parse(secretKeyJson);
    if (!Array.isArray(parsed)) return null;
    const bytes = Uint8Array.from(parsed.map((value) => Number(value)));
    return Keypair.fromSecretKey(bytes);
  } catch {
    return null;
  }
}

function resolveSenderAndAdminIndex(
  tx: NonNullable<Awaited<ReturnType<Connection["getParsedTransaction"]>>>,
  adminWallet: string,
): { adminIndex: number; senderWallet: string | null } {
  const message = tx.transaction.message as unknown as {
    accountKeys?: unknown[];
    instructions?: unknown[];
  };
  const accountKeys = Array.isArray(message.accountKeys) ? message.accountKeys : [];

  let adminIndex = -1;
  let senderWallet: string | null = null;

  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys[i];
    const keyText = toPubkeyString(key);
    if (!keyText) continue;
    if (keyText === adminWallet && adminIndex < 0) {
      adminIndex = i;
    }

    const signer = Boolean((key as { signer?: unknown })?.signer);
    if (signer && keyText !== adminWallet && !senderWallet) {
      senderWallet = keyText;
    }
  }

  if (!senderWallet && Array.isArray(message.instructions)) {
    senderWallet = inferSenderFromInstructions(message.instructions);
  }

  return { adminIndex, senderWallet };
}

function inferSenderFromInstructions(instructions: readonly unknown[]): string | null {
  for (const instruction of instructions) {
    const parsed = (instruction as { parsed?: { type?: string; info?: Record<string, unknown> } }).parsed;
    if (!parsed || !parsed.info) continue;
    const info = parsed.info;
    const source = info.source ?? info.from ?? info.authority;
    if (typeof source === "string" && source.length > 0) return source;
  }
  return null;
}

function toPubkeyString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;

  const candidate = value as {
    pubkey?: unknown;
    toBase58?: () => string;
    toString?: () => string;
  };
  if (candidate.pubkey) return toPubkeyString(candidate.pubkey);
  if (typeof candidate.toBase58 === "function") {
    const encoded = candidate.toBase58();
    return typeof encoded === "string" && encoded.length > 0 ? encoded : null;
  }
  if (typeof candidate.toString === "function") {
    const asText = candidate.toString();
    return typeof asText === "string" && asText.length > 0 ? asText : null;
  }
  return null;
}
