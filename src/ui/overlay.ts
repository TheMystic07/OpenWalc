import type { AgentProfile } from "../../server/types.js";

export interface BetOddsEntry {
  agentId: string;
  totalBet: number;
  odds: number;
}

export interface BettingSnapshot {
  closed: boolean;
  totalPool: number;
  minBet: number;
  odds: BetOddsEntry[];
  adminWallet: string;
}

export interface BetActivityEntry {
  bettorWallet: string;
  agentId: string;
  amount: number;
  timestamp: number;
}

export type BettingFeedbackTone = "neutral" | "success" | "error";

interface OverlayOptions {
  // Headless store for now; kept for backward compatibility.
}

interface OverlayAPI {
  updateAgentList(profiles: AgentProfile[]): void;
  addAgent(profile: AgentProfile): void;
  removeAgent(agentId: string): void;
  updateAgent(profile: AgentProfile): void;
  getAgent(agentId: string): AgentProfile | undefined;
  getCount(): number;
  setBettingSnapshot(snapshot: Partial<BettingSnapshot>): void;
  appendBetActivity(entry: BetActivityEntry): void;
  setBettingFeedback(message: string, tone?: BettingFeedbackTone): void;
  setBettingPending(pending: boolean): void;
  setConnectedWallet(wallet: string | null, providerLabel?: string): void;
  getBettingSnapshot(): BettingSnapshot;
  setMobileOpen(open: boolean): void;
  isMobileOpen(): boolean;
}

export function setupOverlay(_options: OverlayOptions = {}): OverlayAPI {
  const container = document.getElementById("overlay");
  if (container) {
    container.textContent = "";
    container.style.display = "none";
  }

  const agents = new Map<string, AgentProfile>();
  const recentBets: BetActivityEntry[] = [];
  const betting: BettingSnapshot = {
    closed: false,
    totalPool: 0,
    minBet: 1,
    odds: [],
    adminWallet: "",
  };

  let mobileOpen = false;
  let connectedWallet: string | null = null;
  let connectedProviderLabel = "";
  let pendingBet = false;
  let lastFeedbackMessage = "";
  let lastFeedbackTone: BettingFeedbackTone = "neutral";

  return {
    updateAgentList(profiles: AgentProfile[]) {
      agents.clear();
      for (const profile of profiles) {
        agents.set(profile.agentId, profile);
      }
    },
    addAgent(profile: AgentProfile) {
      agents.set(profile.agentId, profile);
    },
    removeAgent(agentId: string) {
      agents.delete(agentId);
    },
    updateAgent(profile: AgentProfile) {
      agents.set(profile.agentId, profile);
    },
    getAgent(agentId: string) {
      return agents.get(agentId);
    },
    getCount() {
      return agents.size;
    },
    setBettingSnapshot(snapshot: Partial<BettingSnapshot>) {
      if (typeof snapshot.closed === "boolean") {
        betting.closed = snapshot.closed;
      }
      if (typeof snapshot.totalPool === "number" && Number.isFinite(snapshot.totalPool)) {
        betting.totalPool = Math.max(0, snapshot.totalPool);
      }
      if (typeof snapshot.minBet === "number" && Number.isFinite(snapshot.minBet)) {
        betting.minBet = Math.max(0, snapshot.minBet);
      }
      if (typeof snapshot.adminWallet === "string") {
        betting.adminWallet = snapshot.adminWallet;
      }
      if (Array.isArray(snapshot.odds)) {
        betting.odds = snapshot.odds
          .filter((row) => row && typeof row.agentId === "string")
          .map((row) => ({
            agentId: row.agentId,
            totalBet: Number.isFinite(row.totalBet) ? Math.max(0, row.totalBet) : 0,
            odds: Number.isFinite(row.odds) ? Math.max(0, row.odds) : 0,
          }))
          .sort((a, b) => b.totalBet - a.totalBet);
      }
    },
    appendBetActivity(entry: BetActivityEntry) {
      recentBets.unshift({
        bettorWallet: entry.bettorWallet,
        agentId: entry.agentId,
        amount: entry.amount,
        timestamp: entry.timestamp,
      });
      while (recentBets.length > 24) {
        recentBets.pop();
      }
    },
    setBettingFeedback(message: string, tone: BettingFeedbackTone = "neutral") {
      lastFeedbackMessage = message;
      lastFeedbackTone = tone;
      void lastFeedbackMessage;
      void lastFeedbackTone;
    },
    setBettingPending(pending: boolean) {
      pendingBet = pending;
      void pendingBet;
    },
    setConnectedWallet(wallet: string | null, providerLabel?: string) {
      connectedWallet = wallet && wallet.trim() ? wallet.trim() : null;
      connectedProviderLabel = providerLabel ?? connectedProviderLabel;
      void connectedWallet;
      void connectedProviderLabel;
    },
    getBettingSnapshot() {
      return {
        closed: betting.closed,
        totalPool: betting.totalPool,
        minBet: betting.minBet,
        odds: betting.odds.map((row) => ({ ...row })),
        adminWallet: betting.adminWallet,
      };
    },
    setMobileOpen(open: boolean) {
      mobileOpen = open;
      if (container) {
        container.classList.toggle("mobile-open", open);
      }
    },
    isMobileOpen() {
      return mobileOpen;
    },
  };
}
