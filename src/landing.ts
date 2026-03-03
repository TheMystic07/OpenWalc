interface RoomApiResponse {
  ok: boolean;
  roomId: string;
  name: string;
  description: string;
  agents: number;
  maxAgents: number;
  survival?: {
    status: "waiting" | "active" | "winner" | "refused" | "timer_ended";
    prizePoolUsd: number;
    winnerAgentId?: string;
    summary?: string;
    recentRounds?: Array<{
      winnerNames?: string[];
      winnerAgentIds?: string[];
      summary?: string;
    }>;
  };
}

interface PublicConfigResponse {
  ok?: boolean;
  token?: {
    symbol?: unknown;
    ca?: unknown;
    chain?: unknown;
    placeholder?: unknown;
  };
}

interface TokenMarketResponse {
  ok?: boolean;
  token?: {
    symbol?: unknown;
    ca?: unknown;
    chain?: unknown;
  };
  market?: {
    status?: unknown;
    priceUsd?: unknown;
    change24h?: unknown;
    marketCap?: unknown;
    fdv?: unknown;
    liquidityUsd?: unknown;
    sourceUrl?: unknown;
    message?: unknown;
    cachedAt?: unknown;
  };
}

const tokenState = {
  symbol: "$WALC",
  ca: "REPLACE_WITH_TOKEN_CA",
  chain: "solana",
  placeholder: true,
};

// Room bar elements
const roomIdEl = document.getElementById("landing-room-id");
const roomAgentsEl = document.getElementById("landing-room-agents");
const roomPoolEl = document.getElementById("landing-room-pool");
const roomDot = document.querySelector(".landing-room-dot") as HTMLElement | null;

// Stats elements
const statAgentsEl = document.getElementById("landing-stat-agents");
const statPoolEl = document.getElementById("landing-stat-pool");

// Token elements
const tokenTitleEl = document.getElementById("landing-token-title");
const tokenShillEl = document.getElementById("landing-shill-symbol");
const tokenStatusEl = document.getElementById("landing-token-status");
const tokenCaEl = document.getElementById("landing-token-ca");
const tokenCopyBtn = document.getElementById("landing-token-copy") as HTMLButtonElement | null;
const tokenPriceEl = document.getElementById("landing-token-price");
const tokenChangeEl = document.getElementById("landing-token-change");
const tokenMcapEl = document.getElementById("landing-token-mcap");
const tokenLiquidityEl = document.getElementById("landing-token-liquidity");
const tokenUpdatedEl = document.getElementById("landing-token-updated");
const tokenSourceEl = document.getElementById("landing-token-source") as HTMLAnchorElement | null;

// Agent onboard
const btnAgent = document.getElementById("btn-agent");
const agentOnboard = document.getElementById("agent-onboard");
const onboardCopy = document.getElementById("onboard-copy");
const onboardCmd = document.getElementById("onboard-cmd");

function buildAutoConnectCommand(): string {
  return "curl -s https://openwalc.mystic.cat/skill.md";
}

function applyOnboardingCommand(): void {
  if (!onboardCmd) return;
  onboardCmd.textContent = buildAutoConnectCommand();
}

function formatUsdCompact(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "--";
  if (amount < 0.01) return `$${amount.toFixed(6)}`;
  if (amount < 1) return `$${amount.toFixed(4)}`;
  if (amount < 1000) return `$${amount.toFixed(2)}`;
  if (amount < 1_000_000) return `$${(amount / 1000).toFixed(1)}k`;
  if (amount < 1_000_000_000) return `$${(amount / 1_000_000).toFixed(1)}m`;
  return `$${(amount / 1_000_000_000).toFixed(2)}b`;
}

function formatStatusLabel(status: string | undefined): string {
  if (!status) return "";
  return status.replaceAll("_", " ").toUpperCase();
}

function setTokenField(element: HTMLElement | null, value: string): void {
  if (element) element.textContent = value;
}

function setTokenStatus(label: string, live: boolean): void {
  if (!tokenStatusEl) return;
  tokenStatusEl.textContent = label;
  tokenStatusEl.classList.toggle("live", live);
}

function applyTokenLabels(): void {
  if (tokenTitleEl) tokenTitleEl.textContent = tokenState.symbol;
  if (tokenShillEl) tokenShillEl.textContent = tokenState.symbol;
  if (tokenCaEl) tokenCaEl.textContent = tokenState.ca;
}

function setTokenPrelaunchState(): void {
  setTokenStatus("Prelaunch", false);
  setTokenField(tokenPriceEl, "TBD");
  setTokenField(tokenChangeEl, "TBD");
  setTokenField(tokenMcapEl, "TBD");
  setTokenField(tokenLiquidityEl, "TBD");
  setTokenField(tokenUpdatedEl, "Replace TOKEN_CA in server env to enable live pricing");
  setTokenSourceLink("");
}

function setTokenSourceLink(url: string): void {
  if (!tokenSourceEl) return;
  tokenSourceEl.textContent = "Chart";
  if (url.trim().length > 0) {
    tokenSourceEl.href = url;
    tokenSourceEl.removeAttribute("aria-disabled");
  } else {
    tokenSourceEl.removeAttribute("href");
    tokenSourceEl.setAttribute("aria-disabled", "true");
  }
}

function parseFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadPublicConfig(): Promise<void> {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return;
    const data = (await response.json()) as PublicConfigResponse;
    const token = data.token;
    if (token && typeof token === "object") {
      if (typeof token.symbol === "string" && token.symbol.trim().length > 0) {
        tokenState.symbol = token.symbol.trim();
      }
      if (typeof token.ca === "string" && token.ca.trim().length > 0) {
        tokenState.ca = token.ca.trim();
      }
      if (typeof token.chain === "string" && token.chain.trim().length > 0) {
        tokenState.chain = token.chain.trim();
      }
      tokenState.placeholder = Boolean(token.placeholder);
    }
    applyTokenLabels();
  } catch {
    // silent
  }
}

async function loadTokenMeta(): Promise<void> {
  if (tokenState.placeholder) {
    setTokenPrelaunchState();
    return;
  }

  try {
    const response = await fetch("/api/token-market");
    if (!response.ok) throw new Error(`token_market_http_${response.status}`);
    const payload = (await response.json()) as TokenMarketResponse;
    const token = payload?.token;
    if (token && typeof token === "object") {
      if (typeof token.symbol === "string" && token.symbol.trim().length > 0) {
        tokenState.symbol = token.symbol.trim();
      }
      if (typeof token.ca === "string" && token.ca.trim().length > 0) {
        tokenState.ca = token.ca.trim();
      }
      if (typeof token.chain === "string" && token.chain.trim().length > 0) {
        tokenState.chain = token.chain.trim();
      }
      tokenState.placeholder = /^REPLACE_/i.test(tokenState.ca);
      applyTokenLabels();
    }

    const market = payload.market;
    const status = typeof market?.status === "string" ? market.status : "error";
    const price = parseFiniteNumber(market?.priceUsd);
    const change24h = parseFiniteNumber(market?.change24h);
    const mcap = parseFiniteNumber(market?.marketCap);
    const fdv = parseFiniteNumber(market?.fdv);
    const liq = parseFiniteNumber(market?.liquidityUsd);
    const cachedAt = parseFiniteNumber(market?.cachedAt);
    const sourceUrl = typeof market?.sourceUrl === "string" ? market.sourceUrl : "";

    if (status === "live") {
      setTokenStatus("Live", true);
      setTokenField(tokenPriceEl, price !== null ? formatUsdCompact(price) : "--");
      if (tokenChangeEl) {
        tokenChangeEl.textContent = change24h !== null
          ? `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%`
          : "--";
        tokenChangeEl.classList.toggle("up", change24h !== null && change24h >= 0);
        tokenChangeEl.classList.toggle("down", change24h !== null && change24h < 0);
      }
      setTokenField(tokenMcapEl, mcap !== null ? formatUsdCompact(mcap) : (fdv !== null ? formatUsdCompact(fdv) : "--"));
      setTokenField(tokenLiquidityEl, liq !== null ? formatUsdCompact(liq) : "--");
      if (tokenUpdatedEl) {
        tokenUpdatedEl.textContent = cachedAt !== null
          ? `Updated ${new Date(cachedAt).toLocaleTimeString()}`
          : `Updated ${new Date().toLocaleTimeString()}`;
      }
      setTokenSourceLink(sourceUrl);
      return;
    }

    if (status === "prelaunch") {
      setTokenPrelaunchState();
      return;
    }

    if (status === "no_pair") {
      setTokenStatus("No Pair", false);
      setTokenField(tokenPriceEl, "--");
      setTokenField(tokenChangeEl, "--");
      setTokenField(tokenMcapEl, "--");
      setTokenField(tokenLiquidityEl, "--");
      setTokenField(tokenUpdatedEl, "No trading pair detected yet");
      setTokenSourceLink("");
      return;
    }

    setTokenStatus("Feed Error", false);
    setTokenField(tokenUpdatedEl, typeof market?.message === "string" ? market.message : "Market feed unavailable");
    setTokenSourceLink("");
  } catch {
    setTokenStatus("Feed Error", false);
    setTokenField(tokenUpdatedEl, "Market feed unavailable");
    setTokenSourceLink("");
  }
}

// Toggle agent onboarding card
btnAgent?.addEventListener("click", () => {
  if (!agentOnboard) return;
  const visible = agentOnboard.style.display !== "none";
  agentOnboard.style.display = visible ? "none" : "block";
  if (!visible) {
    agentOnboard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
});

// Copy curl command
onboardCopy?.addEventListener("click", () => {
  const text = onboardCmd?.textContent ?? "";
  navigator.clipboard.writeText(text).then(() => {
    if (onboardCopy) {
      onboardCopy.textContent = "Copied!";
      setTimeout(() => {
        onboardCopy.textContent = "Copy";
      }, 1500);
    }
  }).catch(() => {
    // clipboard not available
  });
});

// Copy token CA
tokenCopyBtn?.addEventListener("click", () => {
  navigator.clipboard.writeText(tokenState.ca).then(() => {
    tokenCopyBtn.textContent = "Copied!";
    setTimeout(() => {
      tokenCopyBtn.textContent = "Copy CA";
    }, 1500);
  }).catch(() => {
    // clipboard not available
  });
});

async function loadRoomMeta(): Promise<void> {
  try {
    const response = await fetch("/api/room");
    const data = (await response.json()) as RoomApiResponse;
    if (!data.ok) return;

    if (roomIdEl) roomIdEl.textContent = data.roomId;
    const survival = data.survival;
    const statusLabel = formatStatusLabel(survival?.status);
    if (roomAgentsEl) roomAgentsEl.textContent = statusLabel ? `${data.agents} online | ${statusLabel}` : `${data.agents} online`;
    if (roomDot) {
      roomDot.classList.toggle("live", data.agents > 0);
    }

    if (survival && roomPoolEl) {
      roomPoolEl.textContent = formatUsdCompact(survival.prizePoolUsd);
    }

    if (statAgentsEl) statAgentsEl.textContent = String(data.agents);
    if (survival && statPoolEl) {
      statPoolEl.textContent = formatUsdCompact(survival.prizePoolUsd);
    }

    if (roomAgentsEl) {
      const latestRound = Array.isArray(survival?.recentRounds) && survival.recentRounds.length > 0
        ? survival.recentRounds[0]
        : null;
      if (latestRound) {
        const names = Array.isArray(latestRound.winnerNames) && latestRound.winnerNames.length > 0
          ? latestRound.winnerNames.join(", ")
          : Array.isArray(latestRound.winnerAgentIds) && latestRound.winnerAgentIds.length > 0
            ? latestRound.winnerAgentIds.join(", ")
            : "No winner";
        roomAgentsEl.title = `Last result: ${names}${latestRound.summary ? ` | ${latestRound.summary}` : ""}`;
      } else {
        roomAgentsEl.removeAttribute("title");
      }
    }
  } catch {
    // silent
  }
}

applyOnboardingCommand();
applyTokenLabels();
const refreshTokenCard = (): void => {
  loadPublicConfig()
    .then(() => loadTokenMeta())
    .catch(() => {});
};

refreshTokenCard();
loadRoomMeta().catch(() => {});

setInterval(() => {
  loadRoomMeta().catch(() => {});
}, 8000);

setInterval(() => {
  refreshTokenCard();
}, 15000);

