import type { Bet, BetPayout } from "./types.js";

export interface BettingConfig {
  minBet: number;
  walletAddress: string;
}

export type BetResult =
  | { ok: true; bet: Bet }
  | { ok: false; error: string };

export interface PayoutReport {
  winner: string;
  totalPool: number;
  adminWallet: string;
  payouts: BetPayout[];
  generatedAt: number;
}

const MAX_AGENT_ID_LENGTH = 128;
const MAX_WALLET_LENGTH = 128;
const MAX_TX_HASH_LENGTH = 160;

function normalizeStringField(value: string, maxLength: number): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

export class BettingManager {
  private bets: Bet[] = [];
  private txHashes = new Set<string>();
  private closed = false;

  constructor(private readonly config: BettingConfig) {}

  placeBet(bettorWallet: string, agentId: string, amount: number, txHash: string): BetResult {
    if (this.closed) return { ok: false, error: "Betting is closed" };
    const normalizedWallet = normalizeStringField(bettorWallet, MAX_WALLET_LENGTH);
    if (!normalizedWallet) return { ok: false, error: "wallet is required" };
    const normalizedAgentId = normalizeStringField(agentId, MAX_AGENT_ID_LENGTH);
    if (!normalizedAgentId) return { ok: false, error: "agentId is required" };
    const normalizedTxHash = normalizeStringField(txHash, MAX_TX_HASH_LENGTH);
    if (!normalizedTxHash) return { ok: false, error: "txHash is required" };
    if (/\s/.test(normalizedWallet) || /\s/.test(normalizedTxHash)) {
      return { ok: false, error: "wallet/txHash must not contain whitespace" };
    }

    const normalizedAmount = Number(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      return { ok: false, error: "amount must be a positive number" };
    }
    if (normalizedAmount < this.config.minBet) {
      return { ok: false, error: `Minimum bet is ${this.config.minBet}` };
    }
    if (this.txHashes.has(normalizedTxHash)) {
      return { ok: false, error: "Duplicate txHash" };
    }

    const bet: Bet = {
      bettorWallet: normalizedWallet,
      agentId: normalizedAgentId,
      amount: normalizedAmount,
      txHash: normalizedTxHash,
      placedAt: Date.now(),
    };
    this.bets.push(bet);
    this.txHashes.add(bet.txHash);
    return { ok: true, bet };
  }

  getAllBets(): Bet[] {
    return this.bets.map((bet) => ({ ...bet }));
  }

  getTotalPool(): number {
    return this.bets.reduce((total, bet) => total + bet.amount, 0);
  }

  getOdds(): Map<string, number> {
    const totalPool = this.getTotalPool();
    if (totalPool <= 0) return new Map();

    const amountByAgent = new Map<string, number>();
    for (const bet of this.bets) {
      amountByAgent.set(bet.agentId, (amountByAgent.get(bet.agentId) ?? 0) + bet.amount);
    }

    const oddsByAgent = new Map<string, number>();
    for (const [agentId, totalOnAgent] of amountByAgent.entries()) {
      if (totalOnAgent > 0) {
        oddsByAgent.set(agentId, totalPool / totalOnAgent);
      }
    }
    return oddsByAgent;
  }

  getBetsPerAgent(): { agentId: string; totalBet: number; odds: number }[] {
    const totalPool = this.getTotalPool();
    const amountByAgent = new Map<string, number>();

    for (const bet of this.bets) {
      amountByAgent.set(bet.agentId, (amountByAgent.get(bet.agentId) ?? 0) + bet.amount);
    }

    return Array.from(amountByAgent.entries())
      .map(([agentId, totalBet]) => ({
        agentId,
        totalBet,
        odds: totalBet > 0 ? totalPool / totalBet : 0,
      }))
      .sort((a, b) => b.totalBet - a.totalBet);
  }

  resolve(winnerId: string): BetPayout[] {
    const winningBets = this.bets.filter((bet) => bet.agentId === winnerId);
    if (winningBets.length === 0) return [];

    const totalPool = this.getTotalPool();
    const totalWinningBets = winningBets.reduce((sum, bet) => sum + bet.amount, 0);
    if (totalWinningBets <= 0) return [];

    const payoutByWallet = new Map<string, number>();
    for (const bet of winningBets) {
      const amount = (bet.amount / totalWinningBets) * totalPool;
      payoutByWallet.set(bet.bettorWallet, (payoutByWallet.get(bet.bettorWallet) ?? 0) + amount);
    }

    return Array.from(payoutByWallet.entries()).map(([wallet, amount]) => ({
      wallet,
      amount,
      agentId: winnerId,
    }));
  }

  generatePayoutReport(winnerId: string): PayoutReport {
    return {
      winner: winnerId,
      totalPool: this.getTotalPool(),
      adminWallet: this.config.walletAddress,
      payouts: this.resolve(winnerId),
      generatedAt: Date.now(),
    };
  }

  getWalletAddress(): string {
    return this.config.walletAddress;
  }

  closeBetting(): void {
    this.closed = true;
  }

  openBetting(): void {
    this.closed = false;
  }

  isClosed(): boolean {
    return this.closed;
  }

  reset(): void {
    this.bets = [];
    this.txHashes.clear();
    this.closed = false;
  }

  removeBetByTxHash(txHash: string): void {
    const normalizedTxHash = normalizeStringField(txHash, MAX_TX_HASH_LENGTH);
    if (!normalizedTxHash) return;
    this.bets = this.bets.filter((bet) => bet.txHash !== normalizedTxHash);
    this.txHashes.delete(normalizedTxHash);
  }
}
