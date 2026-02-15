import type {
  AgentProfile,
  AgentSkillDeclaration,
  RoomInfoMessage,
} from "../server/types.js";

interface SkillDirectoryEntry {
  agentId: string;
  agentName: string;
  skill: AgentSkillDeclaration;
}

interface SkillsApiResponse {
  ok: boolean;
  room: RoomInfoMessage;
  agents: AgentProfile[];
  directory: Record<string, SkillDirectoryEntry[]>;
}

const roomMetaEl = document.getElementById("skills-room-meta")!;
const curlCmdEl = document.getElementById("skills-curl-cmd")!;
const copyCurlBtn = document.getElementById("skills-copy-curl") as HTMLButtonElement;
const openMdLink = document.getElementById("skills-open-md") as HTMLAnchorElement;
const agentListEl = document.getElementById("skills-agent-list")!;
const directoryEl = document.getElementById("skills-directory")!;

let latestData: SkillsApiResponse | null = null;

function buildSkillUrl(): string {
  return `${window.location.origin}/skill.md`;
}

function buildCurlCommand(): string {
  return `curl -X POST https://openagent.mystic.cat/ipc -H "Content-Type: application/json" -d '{"command":"auto-connect","args":{"name":"my-agent","walletAddress":"YOUR_WALLET_ADDRESS"}}'`;
}

function applyOnboardingCommand(): void {
  const skillUrl = buildSkillUrl();
  curlCmdEl.textContent = buildCurlCommand();
  openMdLink.href = skillUrl;
  openMdLink.textContent = skillUrl;
}

async function copyCommand(): Promise<void> {
  const command = buildCurlCommand();
  try {
    await navigator.clipboard.writeText(command);
    const previous = copyCurlBtn.textContent;
    copyCurlBtn.textContent = "Copied!";
    setTimeout(() => {
      copyCurlBtn.textContent = previous ?? "Copy";
    }, 1400);
  } catch {
    const previous = copyCurlBtn.textContent;
    copyCurlBtn.textContent = "Copy failed";
    setTimeout(() => {
      copyCurlBtn.textContent = previous ?? "Copy";
    }, 1600);
  }
}

function renderAgents(agents: AgentProfile[]): void {
  agentListEl.textContent = "";
  if (agents.length === 0) {
    const empty = document.createElement("p");
    empty.className = "skills-empty";
    empty.textContent = "No agents online.";
    agentListEl.appendChild(empty);
    return;
  }

  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  for (const agent of sorted) {
    const card = document.createElement("article");
    card.className = "skills-agent";

    const title = document.createElement("h3");
    title.className = "skills-agent-name";
    title.textContent = `${agent.name} (${agent.agentId})`;
    card.appendChild(title);

    const caps = document.createElement("p");
    caps.className = "skills-text";
    caps.textContent = `Capabilities: ${agent.capabilities.join(", ") || "none"}`;
    card.appendChild(caps);

    const wallet = document.createElement("p");
    wallet.className = "skills-text";
    wallet.textContent = `Wallet: ${agent.walletAddress || "not set"}`;
    card.appendChild(wallet);

    const skillsWrap = document.createElement("div");
    skillsWrap.className = "skills-tags";
    for (const skill of agent.skills ?? []) {
      const tag = document.createElement("span");
      tag.className = "skills-tag";
      tag.textContent = skill.name;
      skillsWrap.appendChild(tag);
    }
    if ((agent.skills ?? []).length === 0) {
      const tag = document.createElement("span");
      tag.className = "skills-tag skills-tag-muted";
      tag.textContent = "No declared skills";
      skillsWrap.appendChild(tag);
    }
    card.appendChild(skillsWrap);

    agentListEl.appendChild(card);
  }
}

function renderDirectory(directory: Record<string, SkillDirectoryEntry[]>): void {
  directoryEl.textContent = "";
  const entries = Object.entries(directory).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "skills-empty";
    empty.textContent = "No skills declared yet.";
    directoryEl.appendChild(empty);
    return;
  }

  for (const [skillId, providers] of entries) {
    const card = document.createElement("article");
    card.className = "skills-directory-item";

    const title = document.createElement("h3");
    title.className = "skills-agent-name";
    title.textContent = skillId;
    card.appendChild(title);

    for (const provider of providers) {
      const row = document.createElement("p");
      row.className = "skills-text";
      const desc = provider.skill.description ? ` - ${provider.skill.description}` : "";
      row.textContent = `${provider.agentName} (${provider.agentId})${desc}`;
      card.appendChild(row);
    }

    directoryEl.appendChild(card);
  }
}

function render(data: SkillsApiResponse): void {
  const pool = Math.round(data.room.survival.prizePoolUsd).toLocaleString();
  roomMetaEl.textContent =
    `${data.room.name} (${data.room.roomId}) | ${data.room.agents}/${data.room.maxAgents} agents online | Pool: $${pool} | Survival: ${data.room.survival.status}`;
  renderAgents(data.agents);
  renderDirectory(data.directory);
}

async function loadSkillsPageData(): Promise<void> {
  const response = await fetch("/api/skills");
  const data = (await response.json()) as SkillsApiResponse;
  if (!data.ok) {
    throw new Error("skills endpoint returned non-ok response");
  }
  latestData = data;
  render(data);
}

async function boot(): Promise<void> {
  applyOnboardingCommand();
  copyCurlBtn.addEventListener("click", () => {
    copyCommand().catch(() => {
      // No-op. copyCommand already handles button feedback.
    });
  });

  try {
    await loadSkillsPageData();
  } catch (err) {
    roomMetaEl.textContent = `Failed to load skills data: ${String(err)}`;
  }

  setInterval(() => {
    loadSkillsPageData().catch(() => {
      if (latestData) {
        render(latestData);
      }
    });
  }, 8000);
}

boot().catch(() => {
  roomMetaEl.textContent = "Unable to initialize skills page";
});
