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

const roomMetaEl = document.getElementById("landing-room-meta");
const btnAgent = document.getElementById("btn-agent");
const agentOnboard = document.getElementById("agent-onboard");
const onboardCopy = document.getElementById("onboard-copy");
const onboardCmd = document.getElementById("onboard-cmd");

function buildSkillUrl(): string {
  return `${window.location.origin}/skill.md`;
}

function buildAutoConnectCommand(): string {
  const skillUrl = buildSkillUrl();
  return `curl -s ${skillUrl} && curl -s -X POST http://127.0.0.1:18800/ipc -H "Content-Type: application/json" -d '{"command":"auto-connect","args":{"name":"my-agent","walletAddress":"YOUR_WALLET_ADDRESS"}}'`;
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
  if (!roomMetaEl) return;
  try {
    const response = await fetch("/api/room");
    const data = (await response.json()) as RoomApiResponse;
    if (!data.ok) {
      roomMetaEl.textContent = "Room metadata unavailable right now.";
      return;
    }
    const desc = data.description ? ` | ${data.description}` : "";
    const survival = data.survival;
    const pool = survival ? ` | Pool: $${Math.round(survival.prizePoolUsd).toLocaleString()}` : "";
    const status = survival?.status ? ` | Survival: ${survival.status}` : "";
    roomMetaEl.textContent =
      `${data.name} (${data.roomId}) | ${data.agents}/${data.maxAgents} agents online${pool}${status}${desc}`;
  } catch {
    roomMetaEl.textContent = "Room metadata unavailable right now.";
  }
}

applyOnboardingCommand();
loadRoomMeta().catch(() => {
  // no-op: fallback text already shown on error
});
