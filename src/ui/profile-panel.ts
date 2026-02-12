import type { AgentProfile } from "../../server/types.js";

interface ProfilePanelAPI {
  show(profile: AgentProfile): void;
  hide(): void;
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

/**
 * Slide-in profile panel (right side).
 * Click a lobster -> shows agent details.
 */
export function setupProfilePanel(
  onFocusAgent: (agentId: string) => void
): ProfilePanelAPI {
  const container = document.getElementById("profile-panel")!;
  let currentProfile: AgentProfile | null = null;

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

    const timeEl = document.createElement("div");
    timeEl.className = "profile-times";
    timeEl.textContent =
      `Joined: ${new Date(profile.joinedAt).toLocaleDateString()} | ` +
      `Last seen: ${new Date(profile.lastSeen).toLocaleTimeString()}`;
    container.appendChild(timeEl);

    const focusBtn = document.createElement("button");
    focusBtn.className = "profile-focus-btn";
    focusBtn.textContent = "Focus Camera";
    focusBtn.addEventListener("click", () => onFocusAgent(profile.agentId));
    container.appendChild(focusBtn);

    container.classList.add("visible");
    window.addEventListener("keydown", handleEscapeKey);
  }

  function handleEscapeKey(e: KeyboardEvent): void {
    if (e.key === "Escape") hide();
  }

  function hide(): void {
    container.classList.remove("visible");
    currentProfile = null;
    window.removeEventListener("keydown", handleEscapeKey);
  }

  window.addEventListener("agent:select", ((e: CustomEvent) => {
    const agentId = e.detail?.agentId;
    if (agentId) onFocusAgent(agentId);
  }) as EventListener);

  return {
    show(profile: AgentProfile) {
      currentProfile = profile;
      render(profile);
    },
    hide,
  };
}
