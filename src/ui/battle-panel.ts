import type { BattleIntent, BattleMessage, BattleStateSummary } from "../../server/types.js";

interface BattlePanelState extends BattleStateSummary {
  lastSummary?: string;
  lastIntents?: Partial<Record<string, BattleIntent>>;
  lastDamage?: Record<string, number>;
}

interface BattlePanelAPI {
  setBattles(battles: BattleStateSummary[]): void;
  applyEvent(event: BattleMessage): void;
  getSnapshot(): BattleStateSummary[];
  getCombatantIds(): string[];
}

/**
 * Visual battle HUD for live combat readability:
 * - HP bars
 * - intent/damage recap
 * - active turn state
 */
export function setupBattlePanel(resolveName: (agentId: string) => string): BattlePanelAPI {
  const container = document.getElementById("battle-panel")!;
  const states = new Map<string, BattlePanelState>();
  const recent: string[] = [];

  const header = document.createElement("div");
  header.className = "battle-title";
  header.textContent = "Battle Feed";

  const list = document.createElement("div");
  list.className = "battle-list";

  const recentWrap = document.createElement("div");
  recentWrap.className = "battle-recent";

  container.appendChild(header);
  container.appendChild(list);
  container.appendChild(recentWrap);

  function formatIntent(intent: BattleIntent | undefined): string {
    if (!intent) return "waiting";
    return intent.toUpperCase();
  }

  function formatDamage(value: number): string {
    return value > 0 ? `-${value} HP` : "BLOCK";
  }

  function renderFighter(parent: HTMLElement, battle: BattlePanelState, agentId: string): void {
    const hpVal = Math.max(0, Math.min(100, battle.hp[agentId] ?? 0));
    const row = document.createElement("div");
    row.className = "battle-fighter";

    const head = document.createElement("div");
    head.className = "battle-fighter-head";
    head.textContent = `${resolveName(agentId)} - ${hpVal} HP`;
    row.appendChild(head);

    const bar = document.createElement("div");
    bar.className = "battle-hp-bar";
    const fill = document.createElement("div");
    fill.className = "battle-hp-fill";
    fill.style.width = `${hpVal}%`;
    if (hpVal <= 30) fill.classList.add("battle-hp-low");
    bar.appendChild(fill);
    row.appendChild(bar);

    parent.appendChild(row);
  }

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

        const head = document.createElement("div");
        head.className = "battle-card-head";
        head.textContent = `${resolveName(aId)} vs ${resolveName(bId)}`;
        card.appendChild(head);

        const meta = document.createElement("div");
        meta.className = "battle-meta";
        const pending = battle.pending.length > 0
          ? battle.pending.map((id) => resolveName(id)).join(", ")
          : "resolving";
        meta.textContent = `Turn ${battle.turn} | Pending: ${pending}`;
        card.appendChild(meta);

        const fighters = document.createElement("div");
        fighters.className = "battle-fighters";
        renderFighter(fighters, battle, aId);
        renderFighter(fighters, battle, bId);
        card.appendChild(fighters);

        if (battle.lastIntents) {
          const intents = document.createElement("div");
          intents.className = "battle-intents";

          const aIntent = formatIntent(battle.lastIntents[aId]);
          const bIntent = formatIntent(battle.lastIntents[bId]);
          const dmgToA = battle.lastDamage?.[aId] ?? 0;
          const dmgToB = battle.lastDamage?.[bId] ?? 0;

          const rowA = document.createElement("div");
          rowA.className = "battle-intent-row";
          rowA.classList.add(dmgToB > 0 ? "battle-intent-hit" : "battle-intent-block");
          rowA.textContent =
            `${resolveName(aId)} ${aIntent} -> ${resolveName(bId)} ${formatDamage(dmgToB)}`;
          intents.appendChild(rowA);

          const rowB = document.createElement("div");
          rowB.className = "battle-intent-row";
          rowB.classList.add(dmgToA > 0 ? "battle-intent-hit" : "battle-intent-block");
          rowB.textContent =
            `${resolveName(bId)} ${bIntent} -> ${resolveName(aId)} ${formatDamage(dmgToA)}`;
          intents.appendChild(rowB);

          card.appendChild(intents);
        }

        if (battle.lastSummary) {
          const summary = document.createElement("div");
          summary.className = "battle-summary";
          summary.textContent = battle.lastSummary;
          card.appendChild(summary);
        }

        list.appendChild(card);
      }
    }

    recentWrap.textContent = "";
    for (const line of recent.slice(-6).reverse()) {
      const row = document.createElement("div");
      row.className = "battle-recent-line";
      row.textContent = line;
      recentWrap.appendChild(row);
    }
  }

  function upsertFromSummary(summary: BattleStateSummary): void {
    const prev = states.get(summary.battleId);
    states.set(summary.battleId, {
      ...summary,
      lastSummary: prev?.lastSummary,
      lastIntents: prev?.lastIntents,
      lastDamage: prev?.lastDamage,
    });
  }

  function addRecent(line: string): void {
    recent.push(line);
    while (recent.length > 24) {
      recent.shift();
    }
  }

  return {
    setBattles(battles) {
      states.clear();
      for (const b of battles) {
        upsertFromSummary(b);
      }
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
          });
          addRecent(event.summary);
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
            lastSummary: `${resolveName(event.agentId)} chose ${event.intent}`,
            lastIntents: nextIntents,
            lastDamage: current?.lastDamage,
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
            lastSummary: event.summary,
            lastIntents: event.intents,
            lastDamage: event.damage,
          });
          addRecent(event.summary);
          break;
        }

        case "ended":
          states.delete(event.battleId);
          addRecent(event.summary);
          break;
      }

      render();
    },
    getSnapshot() {
      return Array.from(states.values()).map((state) => ({
        battleId: state.battleId,
        participants: state.participants,
        turn: state.turn,
        hp: { ...state.hp },
        pending: [...state.pending],
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
      }));
    },
    getCombatantIds() {
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const battle of states.values()) {
        for (const id of battle.participants) {
          if (seen.has(id)) continue;
          seen.add(id);
          ids.push(id);
        }
      }
      return ids;
    },
  };
}
