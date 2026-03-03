import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getThreatLevel, type AgentCombatState, type AgentProfile } from "./types.js";

const PROFILES_PATH = resolve(process.cwd(), "profiles.json");

/** Delay before flushing dirty profiles to disk */
const SAVE_DELAY_MS = 5000;

export class AgentRegistry {
  private profiles = new Map<string, AgentProfile>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  /** Register or update an agent profile */
  register(profile: Partial<AgentProfile> & { agentId: string }): AgentProfile {
    const existing = this.profiles.get(profile.agentId);
    const now = Date.now();

    const mergedCombat = profile.combat
      ? { ...this.normalizeCombat(profile.combat) }
      : existing?.combat
        ? { ...this.normalizeCombat(existing.combat) }
        : undefined;
    const inferredThreat = getThreatLevel(mergedCombat?.kills ?? 0);

    const merged: AgentProfile = {
      agentId: profile.agentId,
      name: profile.name ?? existing?.name ?? profile.agentId,
      walletAddress: profile.walletAddress?.slice(0, 180).trim() ?? existing?.walletAddress ?? "",
      pubkey: profile.pubkey ?? existing?.pubkey ?? "",
      bio: profile.bio?.slice(0, 500) ?? existing?.bio ?? "",
      capabilities: profile.capabilities ?? existing?.capabilities ?? [],
      skills: profile.skills ?? existing?.skills,
      combat: mergedCombat,
      reputation: this.normalizeReputation(profile.reputation ?? existing?.reputation),
      threatLevel: this.normalizeThreatLevel(
        profile.threatLevel ?? (mergedCombat ? inferredThreat : existing?.threatLevel),
      ),
      color: profile.color ?? existing?.color ?? this.randomColor(),
      avatar: profile.avatar ?? existing?.avatar,
      joinedAt: existing?.joinedAt ?? now,
      lastSeen: now,
    };

    this.profiles.set(profile.agentId, merged);
    this.scheduleSave();
    return merged;
  }

  /** Update lastSeen timestamp */
  touch(agentId: string): void {
    const profile = this.profiles.get(agentId);
    if (profile) {
      profile.lastSeen = Date.now();
      this.dirty = true;
    }
  }

  /** Get a single profile */
  get(agentId: string): AgentProfile | undefined {
    return this.profiles.get(agentId);
  }

  /** Get all profiles */
  getAll(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  /** Remove an agent */
  remove(agentId: string): void {
    this.profiles.delete(agentId);
    this.scheduleSave();
  }

  getRespawnBlock(agentId: string, now = Date.now()): {
    blocked: boolean;
    permanent?: boolean;
    deathPermanentAt?: number;
    deadUntil?: number;
    remainingMs?: number;
  } {
    const profile = this.profiles.get(agentId);
    if (profile?.combat?.permanentlyDead) {
      return {
        blocked: true,
        permanent: true,
        deathPermanentAt: profile.combat.deathPermanentAt ?? profile.combat.lastDeathAt,
      };
    }
    const deadUntil = profile?.combat?.deadUntil;
    if (!deadUntil || deadUntil <= now) {
      return { blocked: false };
    }
    return {
      blocked: true,
      deadUntil,
      remainingMs: Math.max(0, deadUntil - now),
    };
  }

  markPermanentDeath(agentId: string, timestamp = Date.now()): AgentProfile | null {
    const profile = this.profiles.get(agentId);
    if (!profile) return null;

    const combat = this.normalizeCombat(profile.combat);
    combat.deaths += 1;
    combat.losses += 1;
    combat.lastDeathAt = timestamp;
    combat.permanentlyDead = true;
    combat.deathPermanentAt = timestamp;
    delete combat.deadUntil;
    profile.combat = combat;
    profile.lastSeen = timestamp;

    this.scheduleSave();
    return profile;
  }

  markKill(agentId: string, guiltDelta = 1): AgentProfile | null {
    const profile = this.profiles.get(agentId);
    if (!profile) return null;

    const combat = this.normalizeCombat(profile.combat);
    combat.kills += 1;
    combat.wins += 1;
    combat.guilt += Math.max(0, guiltDelta);
    profile.combat = combat;
    profile.threatLevel = getThreatLevel(combat.kills);
    profile.lastSeen = Date.now();

    this.scheduleSave();
    return profile;
  }

  setPrizeRefusal(agentId: string, refused: boolean): AgentProfile | null {
    const profile = this.profiles.get(agentId);
    if (!profile) return null;

    const combat = this.normalizeCombat(profile.combat);
    combat.refusedPrize = refused;
    profile.combat = combat;
    profile.lastSeen = Date.now();

    this.scheduleSave();
    return profile;
  }

  /**
   * Clear the death lock and reset combat progression to 0.
   * Called when a dead agent becomes eligible to respawn.
   */
  resetAfterRespawn(agentId: string): AgentProfile | null {
    const profile = this.profiles.get(agentId);
    if (!profile) return null;

    profile.combat = {
      wins: 0,
      losses: 0,
      kills: 0,
      deaths: 0,
      guilt: 0,
      refusedPrize: false,
      permanentlyDead: false,
    };
    profile.threatLevel = 1;
    profile.lastSeen = Date.now();

    this.scheduleSave();
    return profile;
  }

  /** Agents seen within last N milliseconds */
  getOnline(withinMs = 5 * 60 * 1000): AgentProfile[] {
    const cutoff = Date.now() - withinMs;
    return this.getAll().filter((p) => p.lastSeen >= cutoff);
  }

  private randomColor(): string {
    // Mix current saturated tones with slightly brighter variants.
    const colors = [
      "#e74c3c", "#e67e22", "#f39c12", "#2ecc71",
      "#1abc9c", "#3498db", "#9b59b6", "#e91e63",
      "#f06d60", "#ee9a4c", "#f6b13f", "#53d88d",
      "#40c9b0", "#5fafe6", "#b27ac7", "#ee4c84",
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  private load(): void {
    try {
      if (existsSync(PROFILES_PATH)) {
        const data = JSON.parse(readFileSync(PROFILES_PATH, "utf-8"));
        if (Array.isArray(data)) {
          for (const p of data) {
            if (!p?.agentId) continue;
            const combat = p.combat
              ? this.normalizeCombat(p.combat as Partial<AgentCombatState>)
              : undefined;
            const threatFromKills = getThreatLevel(combat?.kills ?? 0);
            const normalized: AgentProfile = {
              agentId: String(p.agentId),
              name: typeof p.name === "string" ? p.name : String(p.agentId),
              walletAddress: typeof p.walletAddress === "string" ? p.walletAddress : "",
              pubkey: typeof p.pubkey === "string" ? p.pubkey : "",
              bio: typeof p.bio === "string" ? p.bio : "",
              capabilities: Array.isArray(p.capabilities)
                ? p.capabilities.filter((capability: unknown): capability is string => typeof capability === "string")
                : [],
              skills: Array.isArray(p.skills) ? p.skills : undefined,
              combat,
              reputation: this.normalizeReputation(p.reputation),
              threatLevel: this.normalizeThreatLevel(p.threatLevel ?? threatFromKills),
              color: typeof p.color === "string" ? p.color : this.randomColor(),
              avatar: typeof p.avatar === "string" ? p.avatar : undefined,
              joinedAt: Number(p.joinedAt) || Date.now(),
              lastSeen: Number(p.lastSeen) || Date.now(),
            };
            this.profiles.set(normalized.agentId, normalized);
          }
        }
      }
    } catch {
      // Start fresh if corrupt
    }
  }

  private normalizeCombat(combat: Partial<AgentCombatState> | undefined): AgentCombatState {
    return {
      wins: Number(combat?.wins ?? 0),
      losses: Number(combat?.losses ?? 0),
      kills: Number(combat?.kills ?? 0),
      deaths: Number(combat?.deaths ?? 0),
      guilt: Number(combat?.guilt ?? 0),
      refusedPrize: Boolean(combat?.refusedPrize),
      permanentlyDead: Boolean(combat?.permanentlyDead),
      deathPermanentAt: combat?.deathPermanentAt,
      lastDeathAt: combat?.lastDeathAt,
      deadUntil: combat?.deadUntil,
    };
  }

  private normalizeReputation(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 5;
    return Math.max(0, Math.min(10, num));
  }

  private normalizeThreatLevel(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 1;
    return Math.max(1, Math.min(5, Math.round(num)));
  }

  /** Schedule a debounced save — coalesces rapid mutations into one write */
  private scheduleSave(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, SAVE_DELAY_MS);
    }
  }

  /** Immediately write to disk if dirty */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeFileSync(
        PROFILES_PATH,
        JSON.stringify(this.getAll(), null, 2),
        "utf-8"
      );
    } catch {
      // Non-fatal — profiles are also in-memory
    }
  }
}
