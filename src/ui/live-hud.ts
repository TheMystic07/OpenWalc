export type HudEventTone = "neutral" | "battle" | "phase" | "alliance" | "bet";

interface LiveHudCounts {
  agents: number;
  battles: number;
}

export interface LiveHudAPI {
  setPhase(phase: string, endsAt?: number): void;
  setCounts(counts: LiveHudCounts): void;
  setFollowing(name: string | null): void;
  pushEvent(text: string, tone?: HudEventTone): void;
  tick(now?: number): void;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function setupLiveHud(): LiveHudAPI {
  const root = document.createElement("div");
  root.id = "live-hud";

  const phasePill = document.createElement("div");
  phasePill.className = "hud-phase hud-phase-lobby";
  phasePill.textContent = "LOBBY";

  const timerEl = document.createElement("div");
  timerEl.className = "hud-timer";
  timerEl.textContent = "--:--:--";

  const stats = document.createElement("div");
  stats.className = "hud-stats";

  const agentsStat = document.createElement("div");
  agentsStat.className = "hud-stat";
  agentsStat.textContent = "0 AGENTS";

  const battlesStat = document.createElement("div");
  battlesStat.className = "hud-stat";
  battlesStat.textContent = "0 BATTLES";

  stats.appendChild(agentsStat);
  stats.appendChild(battlesStat);

  const followingEl = document.createElement("div");
  followingEl.className = "hud-following";
  followingEl.textContent = "AUTO CAM";

  const eventRail = document.createElement("div");
  eventRail.className = "hud-events";

  root.appendChild(phasePill);
  root.appendChild(timerEl);
  root.appendChild(stats);
  root.appendChild(followingEl);
  root.appendChild(eventRail);
  document.body.appendChild(root);

  let phaseEndsAt = 0;
  let lastTimerFrame = 0;

  function setPhase(phase: string, endsAt?: number): void {
    const normalized = phase.toLowerCase();
    phasePill.className = `hud-phase hud-phase-${normalized}`;
    phasePill.textContent = phase.toUpperCase();
    phaseEndsAt = Number.isFinite(endsAt) ? Number(endsAt) : 0;
  }

  function setCounts(counts: LiveHudCounts): void {
    const agentCount = Math.max(0, Math.floor(counts.agents));
    const battleCount = Math.max(0, Math.floor(counts.battles));
    agentsStat.textContent = `${agentCount} AGENT${agentCount === 1 ? "" : "S"}`;
    battlesStat.textContent = `${battleCount} BATTLE${battleCount === 1 ? "" : "S"}`;
  }

  function setFollowing(name: string | null): void {
    followingEl.textContent = name ? `FOLLOWING ${name}` : "AUTO CAM";
  }

  function pushEvent(text: string, tone: HudEventTone = "neutral"): void {
    if (!text.trim()) return;
    const item = document.createElement("div");
    item.className = `hud-event hud-event-${tone}`;
    item.textContent = text;
    eventRail.prepend(item);
    while (eventRail.children.length > 5) {
      eventRail.removeChild(eventRail.lastChild!);
    }
    window.setTimeout(() => {
      item.classList.add("fade-out");
      window.setTimeout(() => {
        if (item.parentElement === eventRail) eventRail.removeChild(item);
      }, 260);
    }, 7000);
  }

  function tick(now = Date.now()): void {
    if (now - lastTimerFrame < 200) return;
    lastTimerFrame = now;
    if (phaseEndsAt <= 0) {
      timerEl.textContent = "--:--:--";
      return;
    }
    const remaining = phaseEndsAt - now;
    timerEl.textContent = formatCountdown(remaining);
    timerEl.classList.toggle("urgent", remaining > 0 && remaining <= 30_000);
  }

  return {
    setPhase,
    setCounts,
    setFollowing,
    pushEvent,
    tick,
  };
}
