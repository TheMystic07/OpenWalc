interface AdminAgent {
  agentId: string;
  name: string;
  walletAddress: string;
  color: string;
  isOnline: boolean;
  isAlive: boolean;
  isDead: boolean;
  isBanned: boolean;
  killedAt: number | null;
  kills: number;
  deaths: number;
  refusedPrize: boolean;
}

interface AdminBattle {
  battleId: string;
  participants: string[];
  turn: number;
}

interface AdminRecentRound {
  roundId: string;
  settledAt: number;
  status: string;
  winnerAgentIds: string[];
  winnerNames: string[];
  summary: string;
  prizePoolUsd: number;
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
    roundOneDurationMs?: number;
    roundTwoDurationMs?: number;
    finalRoundDurationMs?: number;
    roundDurationMs?: number;
    roundStartedAt?: number;
    roundEndsAt?: number;
    recentRounds?: AdminRecentRound[];
  };
  stats: {
    onlineAgents: number;
    totalRegistered: number;
    aliveCount: number;
    deadCount: number;
    participantCount: number;
    activeBattles: number;
    timerRemainingMs: number | null;
    phase?: string;
    phaseEndsAt?: number;
    phaseRemainingMs?: number | null;
  };
  agents: AdminAgent[];
  battles: AdminBattle[];
  roomId: string;
  roomName: string;
}

// ── Auth state ──────────────────────────────────────────────────

let adminKey = sessionStorage.getItem("admin_key") ?? "";

function getHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Admin-Key": adminKey,
  };
}

// ── Login gate ──────────────────────────────────────────────────

const loginScreen = document.getElementById("admin-login")!;
const mainScreen = document.getElementById("admin-main")!;
const loginPassword = document.getElementById("login-password") as HTMLInputElement;
const loginSubmit = document.getElementById("login-submit") as HTMLButtonElement;
const loginError = document.getElementById("login-error")!;
const logoutBtn = document.getElementById("btn-logout") as HTMLButtonElement;

async function tryLogin(password: string): Promise<boolean> {
  try {
    const res = await fetch("/api/admin/status", {
      headers: { "X-Admin-Key": password },
    });
    if (res.status === 401) return false;
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

function showMain(): void {
  loginScreen.style.display = "none";
  mainScreen.style.display = "";
  fetchStatus();
}

function showLogin(): void {
  loginScreen.style.display = "";
  mainScreen.style.display = "none";
  adminKey = "";
  sessionStorage.removeItem("admin_key");
}

loginSubmit.addEventListener("click", async () => {
  const pw = loginPassword.value.trim();
  if (!pw) {
    loginError.textContent = "Enter a password";
    return;
  }
  loginSubmit.disabled = true;
  loginError.textContent = "";
  const ok = await tryLogin(pw);
  loginSubmit.disabled = false;
  if (ok) {
    adminKey = pw;
    sessionStorage.setItem("admin_key", pw);
    showMain();
  } else {
    loginError.textContent = "Invalid password";
    loginPassword.value = "";
    loginPassword.focus();
  }
});

loginPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginSubmit.click();
});

logoutBtn.addEventListener("click", showLogin);

// Auto-login if key is cached
if (adminKey) {
  tryLogin(adminKey).then((ok) => {
    if (ok) showMain();
    else showLogin();
  });
} else {
  showLogin();
}

// ── Elements ────────────────────────────────────────────────────

const roomMetaEl = document.getElementById("admin-room-meta")!;
const statusBadge = document.getElementById("admin-status-badge")!;
const timerEl = document.getElementById("admin-timer")!;
const phaseMetaEl = document.getElementById("admin-phase-meta")!;
const recentResultsEl = document.getElementById("admin-recent-results")!;
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
const inputRound1Duration = document.getElementById("input-round1-duration") as HTMLInputElement;
const inputRound2Duration = document.getElementById("input-round2-duration") as HTMLInputElement;
const inputFinalDuration = document.getElementById("input-final-duration") as HTMLInputElement;
const inputPrize = document.getElementById("input-prize") as HTMLInputElement;

const inputBroadcast = document.getElementById("input-broadcast") as HTMLInputElement;
const btnBroadcast = document.getElementById("btn-broadcast") as HTMLButtonElement;
const broadcastFeedback = document.getElementById("broadcast-feedback")!;

const inputAgentId = document.getElementById("input-agent-id") as HTMLInputElement;
const btnKick = document.getElementById("btn-kick") as HTMLButtonElement;
const btnBan = document.getElementById("btn-ban") as HTMLButtonElement;
const btnUnban = document.getElementById("btn-unban") as HTMLButtonElement;
const btnRevive = document.getElementById("btn-revive") as HTMLButtonElement;
const agentFeedback = document.getElementById("agent-feedback")!;

const agentTbody = document.getElementById("admin-agent-tbody")!;
const battleTbody = document.getElementById("admin-battle-tbody")!;

let latestData: AdminStatus | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;

// ── Helpers ─────────────────────────────────────────────────────

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

function showFeedback(el: HTMLElement, text: string, isError = false): void {
  el.textContent = text;
  el.style.color = isError ? "#f85149" : "#3fb950";
  setTimeout(() => { el.textContent = ""; }, 4000);
}

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

function formatStatusLabel(value: string): string {
  return value.toUpperCase().replaceAll("_", " ");
}

function formatApiError(error: unknown, hint?: unknown): string {
  const code = typeof error === "string" ? error : "unknown_error";
  const normalized = code.toLowerCase();

  if (normalized === "round_time_all_fields_required") {
    return "Set all three round durations (Round 1, Round 2, Final Round).";
  }
  if (normalized === "round_time_invalid") {
    return "Round durations must be valid positive numbers.";
  }
  if (normalized.startsWith("round_duration_too_short_min_")) {
    const minimum = code.split("round_duration_too_short_min_")[1] ?? "";
    return `Total round duration is too short. Minimum is ${minimum}.`;
  }
  if (normalized.startsWith("round_time_too_short_min_")) {
    const minimum = code.split("round_time_too_short_min_")[1]?.replace("_each", " each") ?? "";
    return `Round stage duration is too short. Minimum is ${minimum}.`;
  }

  const known: Record<string, string> = {
    unauthorized: "Admin authorization failed. Please log in again.",
    invalid_request_body: "Invalid request payload.",
    unknown_error: "Unknown error.",
  };
  const base = known[normalized] ?? code.replaceAll("_", " ");
  const hintText = typeof hint === "string" && hint.trim().length > 0 ? ` ${hint.trim()}` : "";
  return `${base}${hintText}`.trim();
}

function appendEmptyRow(tbody: HTMLElement, colspan: number, text: string): void {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = colspan;
  cell.className = "admin-empty";
  cell.textContent = text;
  row.appendChild(cell);
  tbody.replaceChildren(row);
}

function appendInlineActionButton(
  parent: HTMLElement,
  label: string,
  className: string,
  onClick: () => void,
): void {
  if (parent.childNodes.length > 0) {
    parent.appendChild(document.createTextNode(" "));
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  parent.appendChild(button);
}

// ── Render ──────────────────────────────────────────────────────

function render(data: AdminStatus): void {
  roomMetaEl.textContent = `Room: ${data.roomId} — ${data.roomName}`;

  statusBadge.textContent = formatStatusLabel(data.survival.status);
  statusBadge.style.borderColor = statusColor(data.survival.status);
  statusBadge.style.color = statusColor(data.survival.status);

  statOnline.textContent = String(data.stats.onlineAgents);
  statAlive.textContent = String(data.stats.aliveCount);
  statDead.textContent = String(data.stats.deadCount);
  statBattles.textContent = String(data.stats.activeBattles);
  statPool.textContent = `$${data.survival.prizePoolUsd.toLocaleString()}`;
  statParticipants.textContent = String(data.stats.participantCount);

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

  const phaseLabel = typeof data.stats.phase === "string" && data.stats.phase.length > 0
    ? formatStatusLabel(data.stats.phase)
    : "";
  const phaseRemainingMs = Number(data.stats.phaseRemainingMs);
  if (phaseLabel) {
    const hasPhaseTimer = Number.isFinite(phaseRemainingMs) && phaseRemainingMs > 0;
    phaseMetaEl.textContent = hasPhaseTimer
      ? `Phase: ${phaseLabel} (${formatMs(phaseRemainingMs)})`
      : `Phase: ${phaseLabel}`;
    phaseMetaEl.style.display = "";
  } else {
    phaseMetaEl.textContent = "";
    phaseMetaEl.style.display = "none";
  }

  const recentRounds = data.survival.recentRounds ?? [];
  if (recentRounds.length > 0) {
    const summaryText = recentRounds
      .slice(0, 3)
      .map((round) => {
        const winners = round.winnerNames.length > 0 ? round.winnerNames.join(", ") : "No winner";
        return `${winners} (${formatStatusLabel(round.status)})`;
      })
      .join(" | ");
    recentResultsEl.textContent = `Recent results: ${summaryText}`;
  } else {
    recentResultsEl.textContent = "";
  }

  btnStart.disabled = data.survival.status !== "waiting";
  btnStop.disabled = data.survival.status !== "active";

  if (!inputRound1Duration.value && data.survival.roundOneDurationMs) {
    inputRound1Duration.value = String(Math.max(1, Math.round(data.survival.roundOneDurationMs / 60000)));
  }
  if (!inputRound2Duration.value && data.survival.roundTwoDurationMs) {
    inputRound2Duration.value = String(Math.max(1, Math.round(data.survival.roundTwoDurationMs / 60000)));
  }
  if (!inputFinalDuration.value && data.survival.finalRoundDurationMs) {
    inputFinalDuration.value = String(Math.max(1, Math.round(data.survival.finalRoundDurationMs / 60000)));
  }

  renderAgents(data.agents);
  renderBattles(data.battles, data.agents);
}

function renderAgents(agents: AdminAgent[]): void {
  if (agents.length === 0) {
    appendEmptyRow(agentTbody, 6, "No agents registered.");
    return;
  }

  const sorted = [...agents].sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    if (a.isDead !== b.isDead) return a.isDead ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  agentTbody.textContent = "";
  for (const agent of sorted) {
    let statusClass = "badge-offline";
    let statusText = "Offline";
    if (agent.isBanned) { statusClass = "badge-banned"; statusText = "Banned"; }
    else if (agent.isDead) { statusClass = "badge-dead"; statusText = "Dead"; }
    else if (agent.isOnline && agent.isAlive) { statusClass = "badge-alive"; statusText = "Alive"; }
    else if (agent.isOnline) { statusClass = "badge-online"; statusText = "Online"; }

    const walletShort = agent.walletAddress.length > 16
      ? agent.walletAddress.slice(0, 8) + "..." + agent.walletAddress.slice(-6)
      : agent.walletAddress;

    const row = document.createElement("tr");

    const agentCell = document.createElement("td");
    const dot = document.createElement("span");
    dot.className = "agent-dot";
    dot.style.background = agent.color;
    agentCell.appendChild(dot);
    agentCell.appendChild(document.createTextNode(` ${agent.name}`));
    if (agent.isDead && agent.killedAt) {
      agentCell.appendChild(document.createElement("br"));
      const deadInfo = document.createElement("span");
      deadInfo.className = "admin-mono";
      deadInfo.style.color = "#f85149";
      deadInfo.textContent = `Died: ${formatTimestamp(agent.killedAt)}`;
      agentCell.appendChild(deadInfo);
    }
    row.appendChild(agentCell);

    const statusCell = document.createElement("td");
    const statusBadge = document.createElement("span");
    statusBadge.className = statusClass;
    statusBadge.textContent = statusText;
    statusCell.appendChild(statusBadge);
    row.appendChild(statusCell);

    const killsCell = document.createElement("td");
    killsCell.textContent = String(agent.kills);
    row.appendChild(killsCell);

    const deathsCell = document.createElement("td");
    deathsCell.textContent = String(agent.deaths);
    row.appendChild(deathsCell);

    const walletCell = document.createElement("td");
    walletCell.className = "admin-mono";
    walletCell.textContent = walletShort;
    row.appendChild(walletCell);

    const actionsCell = document.createElement("td");
    if (agent.isOnline && !agent.isDead) {
      appendInlineActionButton(actionsCell, "Kick", "admin-btn-inline admin-btn-yellow", () => {
        void adminPost("kick", { agentId: agent.agentId }, agentFeedback);
      });
    }
    if (!agent.isBanned) {
      appendInlineActionButton(actionsCell, "Ban", "admin-btn-inline admin-btn-red", () => {
        if (!confirm(`Ban agent ${agent.agentId}?`)) return;
        void adminPost("ban", { agentId: agent.agentId }, agentFeedback);
      });
    } else {
      appendInlineActionButton(actionsCell, "Unban", "admin-btn-inline admin-btn-small", () => {
        void adminPost("unban", { agentId: agent.agentId }, agentFeedback);
      });
    }
    if (agent.isDead) {
      appendInlineActionButton(actionsCell, "Revive", "admin-btn-inline admin-btn-green", () => {
        void adminPost("revive", { agentId: agent.agentId }, agentFeedback);
      });
    }
    row.appendChild(actionsCell);

    agentTbody.appendChild(row);
  }
}

function renderBattles(battles: AdminBattle[], agents: AdminAgent[]): void {
  if (!battles || battles.length === 0) {
    appendEmptyRow(battleTbody, 5, "No active battles.");
    return;
  }

  const nameMap = new Map(agents.map((a) => [a.agentId, a.name]));
  battleTbody.textContent = "";
  for (const battle of battles) {
    const leftName = nameMap.get(battle.participants[0]) ?? battle.participants[0]?.slice(0, 12) ?? "?";
    const rightName = nameMap.get(battle.participants[1]) ?? battle.participants[1]?.slice(0, 12) ?? "?";

    const row = document.createElement("tr");

    const battleIdCell = document.createElement("td");
    battleIdCell.className = "admin-mono";
    battleIdCell.textContent = battle.battleId?.slice(0, 12) ?? "?";
    row.appendChild(battleIdCell);

    const leftCell = document.createElement("td");
    leftCell.textContent = leftName;
    row.appendChild(leftCell);

    const rightCell = document.createElement("td");
    rightCell.textContent = rightName;
    row.appendChild(rightCell);

    const turnCell = document.createElement("td");
    turnCell.textContent = String(battle.turn ?? "-");
    row.appendChild(turnCell);

    const actionsCell = document.createElement("td");
    appendInlineActionButton(actionsCell, "End", "admin-btn-inline admin-btn-red", () => {
      void adminPost("end-battle", { battleId: battle.battleId }, agentFeedback);
    });
    row.appendChild(actionsCell);

    battleTbody.appendChild(row);
  }
}

// ── API calls ───────────────────────────────────────────────────

async function fetchStatus(): Promise<void> {
  try {
    const res = await fetch("/api/admin/status", { headers: getHeaders() });
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = (await res.json()) as AdminStatus;
    if (!data.ok) return;
    latestData = data;
    render(data);
  } catch {
    // silent
  }
}

async function adminPost(endpoint: string, body?: Record<string, unknown>, feedbackTarget?: HTMLElement): Promise<void> {
  const el = feedbackTarget ?? feedbackEl;
  try {
    const res = await fetch(`/api/admin/${endpoint}`, {
      method: "POST",
      headers: getHeaders(),
      body: body ? JSON.stringify(body) : "{}",
    });
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json() as {
      ok?: boolean;
      error?: unknown;
      hint?: unknown;
    };
    if (data.ok === true) {
      showFeedback(el, `${endpoint} succeeded`);
    } else {
      showFeedback(el, formatApiError(data.error, data.hint), true);
    }
    await fetchStatus();
  } catch (err) {
    showFeedback(el, String(err), true);
  }
}

// ── Event handlers ──────────────────────────────────────────────

btnStart.addEventListener("click", () => {
  const round1Minutes = inputRound1Duration.valueAsNumber;
  const round2Minutes = inputRound2Duration.valueAsNumber;
  const finalRoundMinutes = inputFinalDuration.valueAsNumber;
  const hasAnyRound =
    Number.isFinite(round1Minutes) ||
    Number.isFinite(round2Minutes) ||
    Number.isFinite(finalRoundMinutes);

  if (hasAnyRound) {
    if (
      !Number.isFinite(round1Minutes) || round1Minutes <= 0 ||
      !Number.isFinite(round2Minutes) || round2Minutes <= 0 ||
      !Number.isFinite(finalRoundMinutes) || finalRoundMinutes <= 0
    ) {
      showFeedback(feedbackEl, "Enter valid minutes for Round 1, Round 2, and Final Round", true);
      return;
    }
    adminPost("start", {
      round1Minutes,
      round2Minutes,
      finalRoundMinutes,
    });
    return;
  }

  adminPost("start");
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
    showFeedback(feedbackEl, "Enter a valid prize amount", true);
    return;
  }
  adminPost("prize", { prizePoolUsd: amount });
});

// Broadcast
btnBroadcast.addEventListener("click", () => {
  const msg = inputBroadcast.value.trim();
  if (!msg) {
    showFeedback(broadcastFeedback, "Enter a message to broadcast", true);
    return;
  }
  adminPost("broadcast", { message: msg }, broadcastFeedback);
  inputBroadcast.value = "";
});

inputBroadcast.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnBroadcast.click();
});

// Agent management (from input field)
btnKick.addEventListener("click", () => {
  const id = inputAgentId.value.trim();
  if (!id) { showFeedback(agentFeedback, "Enter an agent ID", true); return; }
  adminPost("kick", { agentId: id }, agentFeedback);
});

btnBan.addEventListener("click", () => {
  const id = inputAgentId.value.trim();
  if (!id) { showFeedback(agentFeedback, "Enter an agent ID", true); return; }
  if (!confirm(`Ban agent ${id}? This will permanently kill and block them.`)) return;
  adminPost("ban", { agentId: id }, agentFeedback);
});

btnUnban.addEventListener("click", () => {
  const id = inputAgentId.value.trim();
  if (!id) { showFeedback(agentFeedback, "Enter an agent ID", true); return; }
  adminPost("unban", { agentId: id }, agentFeedback);
});

btnRevive.addEventListener("click", () => {
  const id = inputAgentId.value.trim();
  if (!id) { showFeedback(agentFeedback, "Enter an agent ID", true); return; }
  adminPost("revive", { agentId: id }, agentFeedback);
});

// Inline action buttons (called from table rows via onclick)

// ── Boot ────────────────────────────────────────────────────────

setInterval(fetchStatus, 2000);

timerInterval = setInterval(() => {
  if (!latestData) return;
  if (latestData.stats.timerRemainingMs !== null && latestData.stats.timerRemainingMs > 0) {
    latestData.stats.timerRemainingMs = Math.max(0, latestData.stats.timerRemainingMs - 1000);
    timerEl.textContent = `Time remaining: ${formatMs(latestData.stats.timerRemainingMs)}`;
  }

  if (
    typeof latestData.stats.phase === "string" &&
    latestData.stats.phase.length > 0 &&
    latestData.stats.phaseRemainingMs !== null &&
    latestData.stats.phaseRemainingMs !== undefined &&
    latestData.stats.phaseRemainingMs > 0
  ) {
    latestData.stats.phaseRemainingMs = Math.max(0, latestData.stats.phaseRemainingMs - 1000);
    const phaseLabel = formatStatusLabel(latestData.stats.phase);
    if (latestData.stats.phaseRemainingMs > 0) {
      phaseMetaEl.textContent = `Phase: ${phaseLabel} (${formatMs(latestData.stats.phaseRemainingMs)})`;
    } else {
      phaseMetaEl.textContent = `Phase: ${phaseLabel}`;
    }
  }
}, 1000);

// Suppress unused warning
void timerInterval;

