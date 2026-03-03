import type { AgentProfile } from "../../server/types.js";

type BettingFeedbackTone = "neutral" | "success" | "error";

interface BetAgentInput {
  agentId: string;
  wallet: string;
  amount: number;
}

interface ProfilePanelOptions {
  onFocusAgent: (agentId: string) => void;
  onConnectWallet?: () => Promise<{ wallet: string; providerLabel: string }>;
  onBetAgent?: (input: BetAgentInput) => Promise<void> | void;
}

interface ProfilePanelAPI {
  show(profile: AgentProfile): void;
  hide(): void;
  setConnectedWallet(wallet: string | null, providerLabel?: string): void;
  setBettingSnapshot(snapshot: { closed?: boolean; minBet?: number; currency?: string }): void;
  setBettingFeedback(message: string, tone?: BettingFeedbackTone): void;
  setBettingPending(pending: boolean): void;
  isShowingAgent(agentId: string): boolean;
}

function killPowerBonus(kills: number): { bonusPct: number; multiplier: number } {
  const safeKills = Math.max(0, Math.floor(Number(kills) || 0));
  const bonusPct = Math.min(30, safeKills * 3);
  return { bonusPct, multiplier: 1 + bonusPct / 100 };
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function shortWallet(wallet: string): string {
  const normalized = wallet.trim();
  if (!normalized) return "No wallet connected";
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function formatStakeAmount(amount: number): string {
  if (!Number.isFinite(amount)) return "0.000000000";
  if (amount >= 100) return amount.toFixed(2);
  if (amount >= 1) return amount.toFixed(3);
  if (amount >= 0.01) return amount.toFixed(4);
  return amount.toFixed(9);
}

export function setupProfilePanel(options: ProfilePanelOptions): ProfilePanelAPI {
  const container = document.getElementById("profile-panel")!;
  let currentProfile: AgentProfile | null = null;

  let connectedWallet: string | null = null;
  let connectedProviderLabel = "";
  let bettingClosed = false;
  let minBetAmount = 0.000000001;
  let bettingCurrency = "SOL";
  let bettingPending = false;
  let connectingWallet = false;
  let bettingMessage = "";
  let bettingTone: BettingFeedbackTone = "neutral";

  let walletStatusEl: HTMLDivElement | null = null;
  let connectBtnEl: HTMLButtonElement | null = null;
  let betBtnEl: HTMLButtonElement | null = null;
  let stakeInputEl: HTMLInputElement | null = null;
  let bettingStatusEl: HTMLDivElement | null = null;

  function readStakeAmount(): number | null {
    const amount = Number(stakeInputEl?.value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return amount;
  }

  function applyBettingStatus(): void {
    if (!walletStatusEl || !connectBtnEl || !betBtnEl || !bettingStatusEl) return;

    if (connectedWallet) {
      walletStatusEl.textContent = `${connectedProviderLabel || "Wallet"} ${shortWallet(connectedWallet)}`;
      walletStatusEl.classList.add("connected");
    } else {
      walletStatusEl.textContent = "No wallet connected";
      walletStatusEl.classList.remove("connected");
    }

    connectBtnEl.disabled = connectingWallet || bettingPending;
    connectBtnEl.textContent = connectingWallet
      ? "Connecting..."
      : (connectedWallet ? "Reconnect Wallet" : "Connect Wallet");

    const stakeAmount = readStakeAmount();
    const hasValidStake = stakeAmount !== null && stakeAmount >= minBetAmount;
    const displayStake = `${formatStakeAmount(stakeAmount ?? minBetAmount)} ${bettingCurrency}`;
    if (bettingClosed) {
      betBtnEl.textContent = "Betting Closed";
    } else if (bettingPending) {
      betBtnEl.textContent = "Submitting...";
    } else if (!hasValidStake) {
      betBtnEl.textContent = `Enter Stake >= ${formatStakeAmount(minBetAmount)} ${bettingCurrency}`;
    } else if (!connectedWallet) {
      betBtnEl.textContent = `Connect Wallet To Bet`;
    } else if (currentProfile) {
      betBtnEl.textContent = `Bet ${displayStake} On ${currentProfile.name}`;
    } else {
      betBtnEl.textContent = `Bet ${displayStake}`;
    }
    betBtnEl.disabled = bettingClosed || bettingPending || !connectedWallet || !currentProfile || !hasValidStake;

    const fallbackMessage = bettingClosed
      ? "Betting is closed for this phase."
      : `Enter any stake (minimum ${formatStakeAmount(minBetAmount)} ${bettingCurrency}).`;
    bettingStatusEl.className = `profile-bet-status ${bettingTone}`;
    bettingStatusEl.textContent = bettingMessage || fallbackMessage;
  }

  function setBettingMessage(message: string, tone: BettingFeedbackTone = "neutral"): void {
    bettingMessage = message;
    bettingTone = tone;
    applyBettingStatus();
  }

  async function handleConnectWallet(): Promise<void> {
    if (!options.onConnectWallet) {
      setBettingMessage("Wallet connect is not configured.", "error");
      return;
    }
    if (connectingWallet || bettingPending) return;

    connectingWallet = true;
    applyBettingStatus();
    try {
      const wallet = await options.onConnectWallet();
      connectedWallet = wallet.wallet;
      connectedProviderLabel = wallet.providerLabel;
      setBettingMessage(`Connected ${wallet.providerLabel}: ${shortWallet(wallet.wallet)}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "wallet connection failed";
      setBettingMessage(message, "error");
    } finally {
      connectingWallet = false;
      applyBettingStatus();
    }
  }

  async function handleBetAgent(): Promise<void> {
    if (!currentProfile) return;
    if (bettingClosed) {
      setBettingMessage("Betting is closed.", "error");
      return;
    }
    if (!connectedWallet) {
      setBettingMessage("Connect wallet before placing a bet.", "error");
      return;
    }
    if (!options.onBetAgent) {
      setBettingMessage("Bet action is not configured.", "error");
      return;
    }
    const stakeAmount = readStakeAmount();
    if (stakeAmount === null || stakeAmount < minBetAmount) {
      setBettingMessage(`Enter a valid stake (minimum ${formatStakeAmount(minBetAmount)} ${bettingCurrency}).`, "error");
      return;
    }

    bettingPending = true;
    setBettingMessage(`Submitting ${formatStakeAmount(stakeAmount)} ${bettingCurrency} bet...`, "neutral");
    applyBettingStatus();

    try {
      await options.onBetAgent({
        agentId: currentProfile.agentId,
        wallet: connectedWallet,
        amount: stakeAmount,
      });
      setBettingMessage("Bet sent. Waiting for verification...", "neutral");
    } catch (error) {
      bettingPending = false;
      applyBettingStatus();
      const message = error instanceof Error ? error.message : "bet submission failed";
      setBettingMessage(message, "error");
    }
  }

  function render(profile: AgentProfile): void {
    container.textContent = "";

    const closeBtn = document.createElement("button");
    closeBtn.className = "profile-close";
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", () => hide());
    container.appendChild(closeBtn);

    const headerEl = document.createElement("div");
    headerEl.className = "profile-header";

    const swatchEl = document.createElement("div");
    swatchEl.className = "profile-swatch";
    swatchEl.style.background = profile.color;
    headerEl.appendChild(swatchEl);

    const nameEl = document.createElement("h2");
    nameEl.className = "profile-name";
    nameEl.textContent = profile.name;
    headerEl.appendChild(nameEl);

    container.appendChild(headerEl);

    const idEl = document.createElement("div");
    idEl.className = "profile-id";
    idEl.textContent = `ID: ${profile.agentId}`;
    container.appendChild(idEl);

    if (profile.walletAddress) {
      const walletEl = document.createElement("div");
      walletEl.className = "profile-id";
      walletEl.textContent = `Wallet: ${profile.walletAddress}`;
      container.appendChild(walletEl);
    }

    if (profile.pubkey) {
      const pkEl = document.createElement("div");
      pkEl.className = "profile-pubkey";
      pkEl.textContent = `Pubkey: ${profile.pubkey.slice(0, 16)}...`;
      container.appendChild(pkEl);
    }

    if (profile.bio) {
      const bioLabel = document.createElement("div");
      bioLabel.className = "profile-label";
      bioLabel.textContent = "Bio";
      container.appendChild(bioLabel);

      const bioEl = document.createElement("p");
      bioEl.className = "profile-bio";
      bioEl.textContent = profile.bio;
      container.appendChild(bioEl);
    }

    if (profile.capabilities.length > 0) {
      const capLabel = document.createElement("div");
      capLabel.className = "profile-label";
      capLabel.textContent = "Capabilities";
      container.appendChild(capLabel);

      const capsEl = document.createElement("div");
      capsEl.className = "profile-caps";
      for (const cap of profile.capabilities) {
        const tag = document.createElement("span");
        tag.className = "cap-tag";
        tag.textContent = cap;
        capsEl.appendChild(tag);
      }
      container.appendChild(capsEl);
    }

    const combat = profile.combat ?? {
      wins: 0,
      losses: 0,
      kills: 0,
      deaths: 0,
      guilt: 0,
      refusedPrize: false,
      permanentlyDead: false,
    };
    const combatLabel = document.createElement("div");
    combatLabel.className = "profile-label";
    combatLabel.textContent = "Combat";
    container.appendChild(combatLabel);

    const stats = document.createElement("div");
    stats.className = "profile-stats";

    const addStat = (label: string, value: string) => {
      const card = document.createElement("div");
      card.className = "profile-stat";

      const labelEl = document.createElement("div");
      labelEl.className = "profile-stat-label";
      labelEl.textContent = label;
      card.appendChild(labelEl);

      const valueEl = document.createElement("div");
      valueEl.className = "profile-stat-value";
      valueEl.textContent = value;
      card.appendChild(valueEl);

      stats.appendChild(card);
    };

    const power = killPowerBonus(combat.kills);
    const kd = combat.deaths > 0
      ? (combat.kills / combat.deaths).toFixed(2)
      : `${combat.kills}`;

    addStat("Kills", String(combat.kills));
    addStat("Deaths", String(combat.deaths));
    addStat("Wins", String(combat.wins));
    addStat("Losses", String(combat.losses));
    addStat("K/D", kd);
    addStat("Guilt", String(combat.guilt ?? 0));
    addStat("Power", `x${power.multiplier.toFixed(2)} (+${power.bonusPct}%)`);

    container.appendChild(stats);

    if (combat.refusedPrize) {
      const refusal = document.createElement("div");
      refusal.className = "profile-alert";
      refusal.textContent = "Refused prize violence. This agent will not attack for money.";
      container.appendChild(refusal);
    }

    if (combat.permanentlyDead) {
      const lock = document.createElement("div");
      lock.className = "profile-alert";
      lock.textContent = "Permanently dead. This agent cannot respawn.";
      container.appendChild(lock);
    }

    if (combat.deadUntil && combat.deadUntil > Date.now()) {
      const lock = document.createElement("div");
      lock.className = "profile-alert";
      lock.textContent =
        `Dead cooldown active (${formatRemaining(combat.deadUntil - Date.now())} left).`;
      container.appendChild(lock);
    }

    const bettingLabel = document.createElement("div");
    bettingLabel.className = "profile-label";
    bettingLabel.textContent = "Betting";
    container.appendChild(bettingLabel);

    const bettingCard = document.createElement("div");
    bettingCard.className = "profile-bet-card";

    const walletRow = document.createElement("div");
    walletRow.className = "profile-bet-wallet-row";

    walletStatusEl = document.createElement("div");
    walletStatusEl.className = "profile-bet-wallet";

    connectBtnEl = document.createElement("button");
    connectBtnEl.type = "button";
    connectBtnEl.className = "profile-bet-connect-btn";
    connectBtnEl.addEventListener("click", () => {
      void handleConnectWallet();
    });

    walletRow.appendChild(walletStatusEl);
    walletRow.appendChild(connectBtnEl);
    bettingCard.appendChild(walletRow);

    const stakeRow = document.createElement("div");
    stakeRow.className = "profile-bet-stake-row";

    const stakeLabel = document.createElement("label");
    stakeLabel.className = "profile-bet-stake-label";
    stakeLabel.textContent = `Stake (${bettingCurrency})`;
    stakeRow.appendChild(stakeLabel);

    stakeInputEl = document.createElement("input");
    stakeInputEl.className = "profile-bet-input";
    stakeInputEl.type = "number";
    stakeInputEl.min = String(minBetAmount);
    stakeInputEl.step = "any";
    stakeInputEl.placeholder = `Min ${formatStakeAmount(minBetAmount)}`;
    stakeInputEl.value = String(Math.max(0.1, minBetAmount));
    stakeInputEl.addEventListener("input", () => {
      if (bettingTone !== "success") {
        bettingMessage = "";
        bettingTone = "neutral";
      }
      applyBettingStatus();
    });
    stakeRow.appendChild(stakeInputEl);

    bettingCard.appendChild(stakeRow);

    betBtnEl = document.createElement("button");
    betBtnEl.type = "button";
    betBtnEl.className = "profile-bet-submit-btn";
    betBtnEl.addEventListener("click", () => {
      void handleBetAgent();
    });
    bettingCard.appendChild(betBtnEl);

    bettingStatusEl = document.createElement("div");
    bettingStatusEl.className = "profile-bet-status neutral";
    bettingCard.appendChild(bettingStatusEl);

    container.appendChild(bettingCard);

    const timeEl = document.createElement("div");
    timeEl.className = "profile-times";
    timeEl.textContent =
      `Joined: ${new Date(profile.joinedAt).toLocaleDateString()} | ` +
      `Last seen: ${new Date(profile.lastSeen).toLocaleTimeString()}`;
    container.appendChild(timeEl);

    const focusBtn = document.createElement("button");
    focusBtn.className = "profile-focus-btn";
    focusBtn.textContent = "Focus Camera";
    focusBtn.addEventListener("click", () => options.onFocusAgent(profile.agentId));
    container.appendChild(focusBtn);

    container.classList.add("visible");
    window.addEventListener("keydown", handleEscapeKey);
    applyBettingStatus();
  }

  function handleEscapeKey(e: KeyboardEvent): void {
    if (e.key === "Escape") hide();
  }

  function hide(): void {
    container.classList.remove("visible");
    currentProfile = null;
    walletStatusEl = null;
    connectBtnEl = null;
    betBtnEl = null;
    stakeInputEl = null;
    bettingStatusEl = null;
    window.removeEventListener("keydown", handleEscapeKey);
  }

  window.addEventListener("agent:select", ((e: CustomEvent) => {
    const agentId = e.detail?.agentId;
    if (agentId) options.onFocusAgent(agentId);
  }) as EventListener);

  return {
    show(profile: AgentProfile) {
      currentProfile = profile;
      render(profile);
    },
    hide,
    setConnectedWallet(wallet: string | null, providerLabel?: string) {
      connectedWallet = wallet && wallet.trim() ? wallet.trim() : null;
      connectedProviderLabel = providerLabel ?? connectedProviderLabel;
      applyBettingStatus();
    },
    setBettingSnapshot(snapshot: { closed?: boolean; minBet?: number; currency?: string }) {
      if (typeof snapshot.closed === "boolean") {
        bettingClosed = snapshot.closed;
      }
      if (typeof snapshot.minBet === "number" && Number.isFinite(snapshot.minBet)) {
        minBetAmount = Math.max(0.000000001, snapshot.minBet);
        if (stakeInputEl) {
          stakeInputEl.min = String(minBetAmount);
          stakeInputEl.placeholder = `Min ${formatStakeAmount(minBetAmount)}`;
          const currentStake = Number(stakeInputEl.value);
          if (!Number.isFinite(currentStake) || currentStake < minBetAmount) {
            stakeInputEl.value = String(minBetAmount);
          }
        }
      }
      if (typeof snapshot.currency === "string" && snapshot.currency.trim().length > 0) {
        bettingCurrency = snapshot.currency.trim().toUpperCase();
      }
      applyBettingStatus();
    },
    setBettingFeedback(message: string, tone: BettingFeedbackTone = "neutral") {
      setBettingMessage(message, tone);
    },
    setBettingPending(pending: boolean) {
      bettingPending = pending;
      applyBettingStatus();
    },
    isShowingAgent(agentId: string): boolean {
      return currentProfile?.agentId === agentId;
    },
  };
}
