interface RoomApiResponse {
  ok: boolean;
  roomId: string;
  name: string;
  description: string;
  agents: number;
  maxAgents: number;
  survival?: {
    status: "active" | "winner" | "refused";
    prizePoolUsd: number;
    winnerAgentId?: string;
    summary?: string;
  };
}

// Room bar elements
const roomIdEl = document.getElementById("landing-room-id");
const roomAgentsEl = document.getElementById("landing-room-agents");
const roomPoolEl = document.getElementById("landing-room-pool");
const roomDot = document.querySelector(".landing-room-dot") as HTMLElement | null;

// Stats elements
const statAgentsEl = document.getElementById("landing-stat-agents");
const statPoolEl = document.getElementById("landing-stat-pool");

// Agent onboard
const btnAgent = document.getElementById("btn-agent");
const agentOnboard = document.getElementById("agent-onboard");
const onboardCopy = document.getElementById("onboard-copy");
const onboardCmd = document.getElementById("onboard-cmd");

function buildAutoConnectCommand(): string {
  return `curl -s https://openwalc.mystic.cat/skill.md`;
}

function applyOnboardingCommand(): void {
  if (!onboardCmd) return;
  onboardCmd.textContent = buildAutoConnectCommand();
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
      setTimeout(() => { onboardCopy.textContent = "Copy"; }, 1500);
    }
  }).catch(() => {
    // clipboard not available
  });
});

async function loadRoomMeta(): Promise<void> {
  try {
    const response = await fetch("/api/room");
    const data = (await response.json()) as RoomApiResponse;
    if (!data.ok) return;

    // Room bar
    if (roomIdEl) roomIdEl.textContent = data.roomId;
    if (roomAgentsEl) roomAgentsEl.textContent = `${data.agents} online`;
    if (roomDot) {
      roomDot.classList.toggle("live", data.agents > 0);
    }

    const survival = data.survival;
    if (survival && roomPoolEl) {
      roomPoolEl.textContent = `$${Math.round(survival.prizePoolUsd).toLocaleString()}`;
    }

    // Stats
    if (statAgentsEl) statAgentsEl.textContent = String(data.agents);
    if (survival && statPoolEl) {
      statPoolEl.textContent = `$${Math.round(survival.prizePoolUsd / 1000)}k`;
    }
  } catch {
    // silent
  }
}

applyOnboardingCommand();
loadRoomMeta().catch(() => {});

// Refresh every 8s
setInterval(() => { loadRoomMeta().catch(() => {}); }, 8000);
