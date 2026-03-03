import { neon } from "@neondatabase/serverless";
import type { Bet, BetPayout } from "./types.js";

export interface BetVerificationMeta {
  verifiedAmount: number;
  fromWallet?: string | null;
  toWallet?: string | null;
  slot?: number | null;
  blockTime?: number | null;
}

export interface StoredPayoutReport {
  winner: string;
  totalPool: number;
  adminWallet: string;
  payouts: BetPayout[];
  generatedAt: number;
}

export interface PayoutRecord {
  roundId: string;
  winner: string;
  wallet: string;
  amount: number;
  signature: string | null;
  error: string | null;
  executedAt: number;
}

interface NeonBetRow {
  bettor_wallet: string;
  agent_id: string;
  amount: string | number;
  tx_hash: string;
  placed_at: number;
}

interface NeonPayoutRow {
  round_id: string;
  winner_agent_id: string;
  wallet: string;
  amount: string | number;
  tx_signature: string | null;
  error: string | null;
  executed_at: string | number;
}

export class NeonBetStore {
  private readonly sql: ReturnType<typeof neon> | null;
  readonly enabled: boolean;

  constructor(databaseUrl = process.env.NEON_DATABASE_URL) {
    if (!databaseUrl) {
      this.sql = null;
      this.enabled = false;
      return;
    }
    this.sql = neon(databaseUrl);
    this.enabled = true;
  }

  async init(): Promise<void> {
    if (!this.sql) return;
    await this.sql`
      CREATE TABLE IF NOT EXISTS openclaw_bets (
        id BIGSERIAL PRIMARY KEY,
        round_id TEXT NOT NULL,
        bettor_wallet TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        amount NUMERIC(20, 6) NOT NULL,
        tx_hash TEXT NOT NULL UNIQUE,
        placed_at BIGINT NOT NULL,
        verified_amount NUMERIC(20, 6),
        from_wallet TEXT,
        to_wallet TEXT,
        solana_slot BIGINT,
        solana_block_time BIGINT
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_openclaw_bets_round_id
      ON openclaw_bets(round_id)
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_openclaw_bets_round_agent
      ON openclaw_bets(round_id, agent_id)
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS openclaw_payouts (
        id BIGSERIAL PRIMARY KEY,
        round_id TEXT NOT NULL,
        winner_agent_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        amount NUMERIC(20, 6) NOT NULL,
        tx_signature TEXT,
        error TEXT,
        executed_at BIGINT NOT NULL
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_openclaw_payouts_round
      ON openclaw_payouts(round_id)
    `;
  }

  async saveBet(roundId: string, bet: Bet, verification: BetVerificationMeta): Promise<void> {
    if (!this.sql) return;
    await this.sql`
      INSERT INTO openclaw_bets (
        round_id,
        bettor_wallet,
        agent_id,
        amount,
        tx_hash,
        placed_at,
        verified_amount,
        from_wallet,
        to_wallet,
        solana_slot,
        solana_block_time
      ) VALUES (
        ${roundId},
        ${bet.bettorWallet},
        ${bet.agentId},
        ${bet.amount},
        ${bet.txHash},
        ${bet.placedAt},
        ${verification.verifiedAmount},
        ${verification.fromWallet ?? null},
        ${verification.toWallet ?? null},
        ${verification.slot ?? null},
        ${verification.blockTime ?? null}
      )
      ON CONFLICT (tx_hash) DO NOTHING
    `;
  }

  async savePayout(roundId: string, record: PayoutRecord): Promise<void> {
    if (!this.sql) return;
    await this.sql`
      INSERT INTO openclaw_payouts (
        round_id, winner_agent_id, wallet, amount, tx_signature, error, executed_at
      ) VALUES (
        ${roundId},
        ${record.winner},
        ${record.wallet},
        ${record.amount},
        ${record.signature},
        ${record.error},
        ${record.executedAt}
      )
    `;
  }

  async listPayouts(roundId: string): Promise<PayoutRecord[]> {
    if (!this.sql) return [];
    const result = await this.sql`
      SELECT round_id, winner_agent_id, wallet, amount, tx_signature, error, executed_at
      FROM openclaw_payouts
      WHERE round_id = ${roundId}
      ORDER BY executed_at ASC
    `;
    const rows = Array.isArray(result) ? (result as NeonPayoutRow[]) : [];
    return rows.map((row) => ({
      roundId: row.round_id,
      winner: row.winner_agent_id,
      wallet: row.wallet,
      amount: Number(row.amount),
      signature: row.tx_signature,
      error: row.error,
      executedAt: Number(row.executed_at),
    }));
  }

  async listBets(roundId: string): Promise<Bet[]> {
    if (!this.sql) return [];
    const result = await this.sql`
      SELECT bettor_wallet, agent_id, amount, tx_hash, placed_at
      FROM openclaw_bets
      WHERE round_id = ${roundId}
      ORDER BY placed_at ASC
    `;
    const rows = Array.isArray(result) ? (result as NeonBetRow[]) : [];
    return rows.map((row) => ({
      bettorWallet: row.bettor_wallet,
      agentId: row.agent_id,
      amount: Number(row.amount),
      txHash: row.tx_hash,
      placedAt: Number(row.placed_at),
    }));
  }

  async buildPayoutReport(
    roundId: string,
    winnerId: string,
    adminWallet: string,
  ): Promise<StoredPayoutReport> {
    const bets = await this.listBets(roundId);
    const totalPool = bets.reduce((sum, bet) => sum + bet.amount, 0);
    const winningBets = bets.filter((bet) => bet.agentId === winnerId);
    const winningTotal = winningBets.reduce((sum, bet) => sum + bet.amount, 0);
    const walletTotals = new Map<string, number>();

    if (winningTotal > 0 && totalPool > 0) {
      for (const bet of winningBets) {
        const payout = (bet.amount / winningTotal) * totalPool;
        walletTotals.set(bet.bettorWallet, (walletTotals.get(bet.bettorWallet) ?? 0) + payout);
      }
    }

    return {
      winner: winnerId,
      totalPool,
      adminWallet,
      payouts: Array.from(walletTotals.entries()).map(([wallet, amount]) => ({
        wallet,
        amount,
        agentId: winnerId,
      })),
      generatedAt: Date.now(),
    };
  }
}
