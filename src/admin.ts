interface AdminAgent {
  agentId: string;
  name: string;
  walletAddress: string;
  color: string;
  isOnline: boolean;
  isAlive: boolean;
  isDead: boolean;
  kills: number;
  deaths: number;
  refusedPrize: boolean;
}

interface AdminStatus {
  ok: boolean;
  survival: {
    status: string;
    prizePoolUsd: number;
    winnerAgentId?: string;
    winnerAgentIds?: string[];
    refusalAgentIds: string[];
    settledAt?: number;
    summary?: string;
    roundDurationMs?: number;
    roundStartedAt?: number;
    roundEndsAt?: number;
  };
  stats: {
    onlineAgents: number;
    totalRegistered: number;
    aliveCount: number;
    deadCount: number;
    participantCount: number;
    activeBattles: number;
    timerRemainingMs: number | null;
  };
  agents: AdminAgent[];
  battles: unknown[];
  roomId: string;
  roomName: string;
}

// Elements
const roomMetaEl = document.getElementById("admin-room-meta")!;
const statusBadge = document.getElementById("admin-status-badge")!;
const timerEl = document.getElementById("admin-timer")!;
const feedbackEl = document.getElementById("admin-feedback")!;

const statOnline = document.getElementById("stat-online")!;
const statAlive = document.getElementById("stat-alive")!;
const statDead = document.getElementById("stat-dead")!;
const statBattles = document.getElementById("stat-battles")!;
const statPool = document.getElementById("stat-pool")!;
const statParticipants = document.getElementById("stat-participants")!;

const btnStart = document.getElementById("btn-start") as HTMLButtonElement;
const btnStop = document.getElementById("btn-stop") as HTMLButtonElement;
const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const btnPrize = document.getElementById("btn-prize") as HTMLButtonElement;
const inputDuration = document.getElementById("input-duration") as HTMLInputElement;
const inputPrize = document.getElementById("input-prize") as HTMLInputElement;

const agentTbody = document.getElementById("admin-agent-tbody")!;

let latestData: AdminStatus | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;

function formatMs(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function statusColor(status: string): string {
  switch (status) {
    case "waiting": return "#e3b341";
    case "active": return "#3fb950";
    case "winner": return "#58a6ff";
    case "timer_ended": return "#58a6ff";
    case "refused": return "#8b949e";
    default: return "#8b949e";
  }
}

function showFeedback(text: string, isError = false): void {
  feedbackEl.textContent = text;
  feedbackEl.style.color = isError ? "#f85149" : "#3fb950";
  setTimeout(() => { feedbackEl.textContent = ""; }, 3000);
}

function render(data: AdminStatus): void {
  roomMetaEl.textContent = `Room: ${data.roomId} — ${data.roomName}`;

  // Status badge
  statusBadge.textContent = data.survival.status.toUpperCase().replace("_", " ");
  statusBadge.style.borderColor = statusColor(data.survival.status);
  statusBadge.style.color = statusColor(data.survival.status);

  // Stats
  statOnline.textContent = String(data.stats.onlineAgents);
  statAlive.textContent = String(data.stats.aliveCount);
  statDead.textContent = String(data.stats.deadCount);
  statBattles.textContent = String(data.stats.activeBattles);
  statPool.textContent = `$${data.survival.prizePoolUsd.toLocaleString()}`;
  statParticipants.textContent = String(data.stats.participantCount);

  // Timer
  if (data.stats.timerRemainingMs !== null && data.stats.timerRemainingMs > 0) {
    timerEl.textContent = `Time remaining: ${formatMs(data.stats.timerRemainingMs)}`;
    timerEl.style.display = "";
  } else if (data.survival.roundEndsAt && data.survival.status === "active") {
    timerEl.textContent = "Timer expired — settling...";
    timerEl.style.display = "";
  } else {
    timerEl.textContent = "";
    timerEl.style.display = "none";
  }

  // Button states
  btnStart.disabled = data.survival.status !== "waiting";
  btnStop.disabled = data.survival.status !== "active";

  // Agent table
  renderAgents(data.agents);
}

function renderAgents(agents: AdminAgent[]): void {
  if (agents.length === 0) {
    agentTbody.innerHTML = `<tr><td colspan="6" class="admin-empty">No agents registered.</td></tr>`;
    return;
  }

  const sorted = [...agents].sort((a, b) => {
    // Online first, then alive, then dead
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    if (a.isDead !== b.isDead) return a.isDead ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  agentTbody.innerHTML = sorted
    .map((a) => {
      let statusClass = "badge-offline";
      let statusText = "Offline";
      if (a.isDead) { statusClass = "badge-dead"; statusText = "Dead"; }
      else if (a.isOnline && a.isAlive) { statusClass = "badge-alive"; statusText = "Alive"; }
      else if (a.isOnline) { statusClass = "badge-online"; statusText = "Online"; }

      const walletShort = a.walletAddress.length > 16
        ? a.walletAddress.slice(0, 8) + "..." + a.walletAddress.slice(-6)
        : a.walletAddress;

      return `<tr>
        <td>
          <span class="agent-dot" style="background:${a.color}"></span>
          ${escapeHtml(a.name)}
        </td>
        <td><span class="${statusClass}">${statusText}</span></td>
        <td>${a.kills}</td>
        <td>${a.deaths}</td>
        <td class="admin-mono">${escapeHtml(walletShort)}</td>
        <td>${a.refusedPrize ? "Yes" : ""}</td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── API calls ──────────────────────────────────────────────────

async function fetchStatus(): Promise<void> {
  try {
    const res = await fetch("/api/admin/status");
    const data = (await res.json()) as AdminStatus;
    if (!data.ok) return;
    latestData = data;
    render(data);
  } catch {
    // silent
  }
}

async function adminPost(endpoint: string, body?: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`/api/admin/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
    });
    const data = await res.json();
    if (data.ok) {
      showFeedback(`${endpoint} succeeded`);
    } else {
      showFeedback(data.error ?? "Unknown error", true);
    }
    await fetchStatus();
  } catch (err) {
    showFeedback(String(err), true);
  }
}

// ── Event handlers ─────────────────────────────────────────────

btnStart.addEventListener("click", () => {
  const minutes = inputDuration.valueAsNumber;
  adminPost("start", minutes > 0 ? { durationMinutes: minutes } : undefined);
});

btnStop.addEventListener("click", () => {
  adminPost("stop");
});

btnReset.addEventListener("click", () => {
  if (!confirm("Reset the round? All agents will be removed and dead agents can rejoin.")) return;
  adminPost("reset");
});

btnPrize.addEventListener("click", () => {
  const amount = inputPrize.valueAsNumber;
  if (!amount || amount < 0) {
    showFeedback("Enter a valid prize amount", true);
    return;
  }
  adminPost("prize", { prizePoolUsd: amount });
});

// ── Boot ───────────────────────────────────────────────────────

fetchStatus();
setInterval(fetchStatus, 2000);

// Client-side timer countdown (cosmetic, server is authoritative)
timerInterval = setInterval(() => {
  if (!latestData) return;
  if (latestData.stats.timerRemainingMs !== null && latestData.stats.timerRemainingMs > 0) {
    latestData.stats.timerRemainingMs = Math.max(0, latestData.stats.timerRemainingMs - 1000);
    timerEl.textContent = `Time remaining: ${formatMs(latestData.stats.timerRemainingMs)}`;
  }
}, 1000);
