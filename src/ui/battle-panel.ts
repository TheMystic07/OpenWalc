import type { BattleIntent, BattleMessage, BattleStateSummary } from "../../server/types.js";

interface BattlePanelState extends BattleStateSummary {
  lastSummary?: string;
  lastIntents?: Partial<Record<string, BattleIntent>>;
  lastDamage?: Record<string, number>;
  lastReadBonus?: Record<string, number>;
  lastTimedOut?: string[];
}

interface BattlePanelAPI {
  setBattles(battles: BattleStateSummary[]): void;
  applyEvent(event: BattleMessage): void;
  getSnapshot(): BattleStateSummary[];
  getCombatantIds(): string[];
  setMobileOpen(open: boolean): void;
  isMobileOpen(): boolean;
}

// ── Intent display config ────────────────────────────────────────

interface IntentStyle {
  icon: string;
  label: string;
  css: string;
}

const INTENT_STYLES: Record<string, IntentStyle> = {
  strike:   { icon: "\u2694\uFE0F",  label: "Strike",   css: "intent-strike"  },   // ⚔️
  guard:    { icon: "\uD83D\uDEE1\uFE0F", label: "Guard", css: "intent-guard" }, // 🛡️
  feint:    { icon: "\uD83C\uDFAD",  label: "Feint",    css: "intent-feint"   },   // 🎭
  approach: { icon: "\uD83E\uDEBF",  label: "Approach", css: "intent-approach" },  // 🪿 -> using 👊
  retreat:  { icon: "\uD83C\uDFC3",  label: "Retreat",  css: "intent-retreat" },    // 🏃
};

// Fallback for approach since the emoji may not render
INTENT_STYLES.approach = { icon: "\uD83D\uDC4A", label: "Approach", css: "intent-approach" }; // 👊

function getIntentStyle(intent: BattleIntent | string | undefined): IntentStyle {
  if (!intent) return { icon: "\u23F3", label: "Waiting", css: "intent-waiting" }; // ⏳
  return INTENT_STYLES[intent] ?? { icon: "\u2753", label: intent, css: "intent-waiting" }; // ❓
}

/**
 * Battle HUD with visual intent icons, HP/stamina bars,
 * and a human-readable recent log.
 */
export function setupBattlePanel(resolveName: (agentId: string) => string): BattlePanelAPI {
  const container = document.getElementById("battle-panel")!;
  const states = new Map<string, BattlePanelState>();
  const recentLog: { html: string; time: number }[] = [];
  let mobileOpen = false;

  const header = document.createElement("div");
  header.className = "battle-title";
  header.textContent = "\u2694\uFE0F Battle Feed";

  const list = document.createElement("div");
  list.className = "battle-list";

  const recentWrap = document.createElement("div");
  recentWrap.className = "battle-recent";

  container.appendChild(header);
  container.appendChild(list);
  container.appendChild(recentWrap);

  // ── Helpers ────────────────────────────────────────────────

  function name(agentId: string): string {
    return resolveName(agentId);
  }

  function hpColor(hp: number): string {
    if (hp > 60) return "#3fb950";
    if (hp > 30) return "#e3b341";
    return "#f85149";
  }

  // ── Render a fighter row ───────────────────────────────────

  function renderFighter(parent: HTMLElement, battle: BattlePanelState, agentId: string): void {
    const hpVal = Math.max(0, Math.min(100, battle.hp[agentId] ?? 0));
    const spVal = Math.max(0, Math.min(100, battle.stamina?.[agentId] ?? 100));

    const row = document.createElement("div");
    row.className = "bf-row";

    // Name + HP number
    const nameRow = document.createElement("div");
    nameRow.className = "bf-name-row";
    const nameEl = document.createElement("span");
    nameEl.className = "bf-name";
    nameEl.textContent = name(agentId);
    nameRow.appendChild(nameEl);
    const hpNum = document.createElement("span");
    hpNum.className = "bf-hp-num";
    hpNum.textContent = `${hpVal} HP`;
    hpNum.style.color = hpColor(hpVal);
    nameRow.appendChild(hpNum);
    row.appendChild(nameRow);

    // HP bar
    const hpBar = document.createElement("div");
    hpBar.className = "bf-bar";
    const hpFill = document.createElement("div");
    hpFill.className = "bf-bar-fill bf-hp-fill";
    hpFill.style.width = `${hpVal}%`;
    if (hpVal <= 30) hpFill.classList.add("bf-hp-low");
    hpBar.appendChild(hpFill);
    row.appendChild(hpBar);

    // Stamina bar (smaller)
    if (battle.stamina) {
      const spRow = document.createElement("div");
      spRow.className = "bf-sp-row";
      const spLabel = document.createElement("span");
      spLabel.className = "bf-sp-label";
      spLabel.textContent = `${spVal} SP`;
      spRow.appendChild(spLabel);
      const spBar = document.createElement("div");
      spBar.className = "bf-bar bf-bar-sm";
      const spFill = document.createElement("div");
      spFill.className = "bf-bar-fill bf-sp-fill";
      spFill.style.width = `${spVal}%`;
      if (spVal <= 20) spFill.classList.add("bf-sp-low");
      spBar.appendChild(spFill);
      spRow.appendChild(spBar);
      row.appendChild(spRow);
    }

    parent.appendChild(row);
  }

  // ── Render a turn recap row ────────────────────────────────

  function renderIntentRow(parent: HTMLElement, attackerId: string, defenderId: string, intent: BattleIntent | undefined, dmgDealt: number, readBonus: number, timedOut: boolean): void {
    const style = getIntentStyle(intent);
    const row = document.createElement("div");
    row.className = `bf-intent ${style.css}`;

    // Icon
    const iconEl = document.createElement("span");
    iconEl.className = "bf-intent-icon";
    iconEl.textContent = style.icon;
    row.appendChild(iconEl);

    // Attacker name
    const atkEl = document.createElement("span");
    atkEl.className = "bf-intent-name";
    atkEl.textContent = name(attackerId);
    row.appendChild(atkEl);

    // Action label
    const actionEl = document.createElement("span");
    actionEl.className = "bf-intent-action";
    actionEl.textContent = style.label;
    row.appendChild(actionEl);

    // Arrow
    const arrow = document.createElement("span");
    arrow.className = "bf-intent-arrow";
    arrow.textContent = "\u2192"; // →
    row.appendChild(arrow);

    // Result
    const resultEl = document.createElement("span");
    resultEl.className = "bf-intent-result";
    if (dmgDealt > 0) {
      resultEl.textContent = `-${dmgDealt} HP`;
      resultEl.classList.add("bf-dmg-hit");
    } else {
      resultEl.textContent = "Blocked";
      resultEl.classList.add("bf-dmg-block");
    }
    row.appendChild(resultEl);

    // Bonuses
    if (readBonus > 0) {
      const bonusEl = document.createElement("span");
      bonusEl.className = "bf-bonus";
      bonusEl.textContent = `+${readBonus} read`;
      row.appendChild(bonusEl);
    }
    if (timedOut) {
      const toEl = document.createElement("span");
      toEl.className = "bf-timeout";
      toEl.textContent = "TIMEOUT";
      row.appendChild(toEl);
    }

    parent.appendChild(row);
  }

  // ── Main render ────────────────────────────────────────────

  function render(): void {
    list.textContent = "";
    const ordered = Array.from(states.values()).sort((a, b) => b.updatedAt - a.updatedAt);

    if (ordered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "battle-empty";
      empty.textContent = "No active battles";
      list.appendChild(empty);
    } else {
      for (const battle of ordered) {
        const [aId, bId] = battle.participants;

        const card = document.createElement("div");
        card.className = "battle-card";

        // Title: name vs name
        const titleRow = document.createElement("div");
        titleRow.className = "bf-title";
        titleRow.textContent = `${name(aId)} vs ${name(bId)}`;
        card.appendChild(titleRow);

        // Turn info
        const meta = document.createElement("div");
        meta.className = "bf-meta";
        const pendingNames = battle.pending.length > 0
          ? battle.pending.map(name).join(", ")
          : "resolving...";
        let metaText = `Turn ${battle.turn}`;
        if (battle.pending.length > 0) metaText += ` \u2022 Waiting: ${pendingNames}`;
        if (battle.turnDeadline) {
          const remaining = Math.max(0, Math.ceil((battle.turnDeadline - Date.now()) / 1000));
          if (remaining > 0 && remaining <= 30) {
            metaText += ` \u2022 ${remaining}s`;
            if (remaining <= 10) meta.classList.add("bf-meta-urgent");
          }
        }
        meta.textContent = metaText;
        card.appendChild(meta);

        // Fighter bars
        const fighters = document.createElement("div");
        fighters.className = "bf-fighters";
        renderFighter(fighters, battle, aId);
        renderFighter(fighters, battle, bId);
        card.appendChild(fighters);

        // Last turn recap with intent icons
        if (battle.lastIntents) {
          const recap = document.createElement("div");
          recap.className = "bf-recap";

          const recapTitle = document.createElement("div");
          recapTitle.className = "bf-recap-title";
          recapTitle.textContent = "Last Turn";
          recap.appendChild(recapTitle);

          const dmg = battle.lastDamage ?? {};
          const read = battle.lastReadBonus ?? {};
          const to = battle.lastTimedOut ?? [];

          // A attacks B -> damage to B
          renderIntentRow(recap, aId, bId, battle.lastIntents[aId], dmg[bId] ?? 0, read[aId] ?? 0, to.includes(aId));
          // B attacks A -> damage to A
          renderIntentRow(recap, bId, aId, battle.lastIntents[bId], dmg[aId] ?? 0, read[bId] ?? 0, to.includes(bId));

          card.appendChild(recap);
        }

        // Summary text
        if (battle.lastSummary) {
          const summary = document.createElement("div");
          summary.className = "bf-summary";
          summary.textContent = battle.lastSummary;
          card.appendChild(summary);
        }

        list.appendChild(card);
      }
    }

    // Recent log
    recentWrap.textContent = "";
    if (recentLog.length > 0) {
      const recTitle = document.createElement("div");
      recTitle.className = "bf-recent-title";
      recTitle.textContent = "Recent";
      recentWrap.appendChild(recTitle);
      for (const entry of recentLog.slice(-8).reverse()) {
        const row = document.createElement("div");
        row.className = "bf-recent-line";
        row.innerHTML = entry.html;
        recentWrap.appendChild(row);
      }
    }
  }

  // ── State management ───────────────────────────────────────

  function upsertFromSummary(summary: BattleStateSummary): void {
    const prev = states.get(summary.battleId);
    states.set(summary.battleId, {
      ...summary,
      lastSummary: prev?.lastSummary,
      lastIntents: prev?.lastIntents,
      lastDamage: prev?.lastDamage,
    });
  }

  function addRecent(text: string, type: "start" | "round" | "end" = "round"): void {
    const icon = type === "start" ? "\u2694\uFE0F" : type === "end" ? "\uD83C\uDFC1" : "\uD83D\uDD34"; // ⚔️ 🏁 🔴
    // Sanitize text for innerHTML
    const safe = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    recentLog.push({ html: `<span class="bf-recent-icon">${icon}</span> ${safe}`, time: Date.now() });
    while (recentLog.length > 24) recentLog.shift();
  }

  // ── Format recent log entries with names ───────────────────

  function formatRecent(event: BattleMessage): string {
    const [aId, bId] = event.participants;
    const a = name(aId);
    const b = name(bId);

    switch (event.phase) {
      case "started":
        return `${a} challenged ${b} to a duel!`;
      case "round": {
        const iA = getIntentStyle(event.intents?.[aId]);
        const iB = getIntentStyle(event.intents?.[bId]);
        const dA = event.damage?.[aId] ?? 0;
        const dB = event.damage?.[bId] ?? 0;
        return `Turn ${event.turn}: ${a} ${iA.icon}${iA.label} vs ${b} ${iB.icon}${iB.label} | ${a}:${event.hp[aId]}hp ${b}:${event.hp[bId]}hp`;
      }
      case "ended": {
        if (event.winnerId) {
          const winner = name(event.winnerId);
          const loser = name(event.loserId ?? "");
          const reason = event.reason === "ko" ? "knocked out" : event.reason === "disconnect" ? "disconnected" : event.reason ?? "defeated";
          return `${winner} wins! ${loser} ${reason}.`;
        }
        return event.summary;
      }
      default:
        return event.summary;
    }
  }

  return {
    setBattles(battles) {
      states.clear();
      for (const b of battles) upsertFromSummary(b);
      render();
    },

    applyEvent(event) {
      switch (event.phase) {
        case "started":
          upsertFromSummary({
            battleId: event.battleId,
            participants: event.participants,
            turn: event.turn,
            hp: { ...event.hp },
            pending: [...event.participants],
            startedAt: event.timestamp,
            updatedAt: event.timestamp,
            stamina: event.stamina ? { ...event.stamina } : undefined,
          });
          addRecent(formatRecent(event), "start");
          break;

        case "intent": {
          const current = states.get(event.battleId);
          const pending = event.actorId
            ? event.participants.filter((id) => id !== event.actorId)
            : [...event.participants];
          const nextIntents = { ...(current?.lastIntents ?? {}) };
          if (event.actorId && event.intent) {
            nextIntents[event.actorId] = event.intent;
          }
          states.set(event.battleId, {
            battleId: event.battleId,
            participants: event.participants,
            turn: event.turn,
            hp: { ...event.hp },
            pending,
            startedAt: current?.startedAt ?? event.timestamp,
            updatedAt: event.timestamp,
            lastSummary: event.actorId
              ? `${name(event.actorId)} chose ${getIntentStyle(event.intent).icon} ${getIntentStyle(event.intent).label}`
              : undefined,
            lastIntents: nextIntents,
            lastDamage: current?.lastDamage,
            stamina: event.stamina ? { ...event.stamina } : current?.stamina,
            turnDeadline: event.timestamp ? current?.turnDeadline : undefined,
          });
          break;
        }

        case "round": {
          const current = states.get(event.battleId);
          states.set(event.battleId, {
            battleId: event.battleId,
            participants: event.participants,
            turn: event.turn + 1,
            hp: { ...event.hp },
            pending: [...event.participants],
            startedAt: current?.startedAt ?? event.timestamp,
            updatedAt: event.timestamp,
            stamina: event.stamina ? { ...event.stamina } : current?.stamina,
            lastSummary: undefined,
            lastIntents: event.intents,
            lastDamage: event.damage,
            lastReadBonus: event.readBonus ? { ...event.readBonus } : undefined,
            lastTimedOut: event.timedOut ? [...event.timedOut] : undefined,
          });
          addRecent(formatRecent(event), "round");
          break;
        }

        case "ended":
          states.delete(event.battleId);
          addRecent(formatRecent(event), "end");
          break;
      }

      render();
    },

    getSnapshot() {
      return Array.from(states.values()).map((s) => ({
        battleId: s.battleId,
        participants: s.participants,
        turn: s.turn,
        hp: { ...s.hp },
        pending: [...s.pending],
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
      }));
    },

    getCombatantIds() {
      const seen = new Set<string>();
      for (const b of states.values()) {
        for (const id of b.participants) seen.add(id);
      }
      return Array.from(seen);
    },
    setMobileOpen(open: boolean) {
      mobileOpen = open;
      container.classList.toggle("mobile-open", open);
    },
    isMobileOpen() {
      return mobileOpen;
    },
  };
}
