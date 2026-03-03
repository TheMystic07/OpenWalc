import type { GamePhase, PhaseState } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;

export interface PhaseConfig {
  lobbyHours: number;
  battleHours: number;
  showdownHours: number;
  zoneShrinkIntervalHours: number;
  zoneFinalRadius: number;
  worldRadius: number;
}

export interface PhaseTimelineMs {
  lobbyMs: number;
  battleMs: number;
  showdownMs: number;
}

export interface PhaseRestoreState {
  phase: GamePhase;
  startedAt: number;
  roundNumber: number;
  safeZoneRadius?: number;
  winnerId?: string | null;
  timelineMs?: Partial<PhaseTimelineMs>;
}

type PhaseChangeListener = (next: GamePhase, previous: GamePhase) => void;

export class PhaseManager {
  private phase: GamePhase = "lobby";
  private roundStartedAt: number | null = null;
  private roundNumber = 0;
  private safeZoneRadius: number;
  private winnerId: string | null = null;
  private listeners: PhaseChangeListener[] = [];
  private timelineMs: PhaseTimelineMs;

  constructor(private readonly config: PhaseConfig) {
    this.safeZoneRadius = config.worldRadius;
    this.timelineMs = this.defaultTimelineMs();
  }

  getPhase(): GamePhase {
    return this.phase;
  }

  getSafeZoneRadius(): number {
    return this.safeZoneRadius;
  }

  getRoundNumber(): number {
    return this.roundNumber;
  }

  getWinnerId(): string | null {
    return this.winnerId;
  }

  getState(): PhaseState {
    return {
      phase: this.phase,
      startedAt: this.roundStartedAt ?? 0,
      endsAt: this.getPhaseEndsAt(),
      roundNumber: this.roundNumber,
      safeZoneRadius: this.safeZoneRadius,
      safeZoneCenter: { x: 0, z: 0 },
    };
  }

  getTimelineMs(): PhaseTimelineMs {
    return {
      lobbyMs: this.timelineMs.lobbyMs,
      battleMs: this.timelineMs.battleMs,
      showdownMs: this.timelineMs.showdownMs,
    };
  }

  onPhaseChange(listener: PhaseChangeListener): void {
    this.listeners.push(listener);
  }

  startRound(now = Date.now(), timelineMs?: Partial<PhaseTimelineMs>): void {
    this.timelineMs = this.resolveTimelineMs(timelineMs);
    this.roundStartedAt = now;
    this.roundNumber += 1;
    this.winnerId = null;
    this.safeZoneRadius = this.config.worldRadius;
    this.setPhase("lobby");
  }

  endRound(winnerId: string | null): void {
    this.winnerId = winnerId;
    this.setPhase("ended");
  }

  reset(): void {
    this.phase = "lobby";
    this.roundStartedAt = null;
    this.safeZoneRadius = this.config.worldRadius;
    this.winnerId = null;
    this.timelineMs = this.defaultTimelineMs();
  }

  restore(state: PhaseRestoreState): void {
    const roundNumber = Number.isFinite(state.roundNumber)
      ? Math.max(0, Math.floor(state.roundNumber))
      : 0;
    const startedAtRaw = Number(state.startedAt);
    const startedAt = Number.isFinite(startedAtRaw) && startedAtRaw > 0
      ? Math.floor(startedAtRaw)
      : null;
    const safeZoneRaw = Number(state.safeZoneRadius);
    const safeZoneRadius = Number.isFinite(safeZoneRaw)
      ? Math.max(this.config.zoneFinalRadius, Math.min(this.config.worldRadius, safeZoneRaw))
      : this.config.worldRadius;
    this.timelineMs = this.resolveTimelineMs(state.timelineMs);

    this.roundNumber = roundNumber;
    this.roundStartedAt = startedAt;
    this.phase = state.phase;
    this.winnerId = state.winnerId ?? null;
    this.safeZoneRadius = this.phase === "showdown" ? safeZoneRadius : this.config.worldRadius;
  }

  isCombatAllowed(): boolean {
    return this.phase === "battle" || this.phase === "showdown";
  }

  getAllianceMaxSize(): number {
    return this.phase === "showdown" ? 2 : 4;
  }

  isAutoAcceptChallenge(): boolean {
    return this.phase === "showdown";
  }

  tick(now = Date.now()): void {
    if (this.roundStartedAt === null || this.phase === "ended") return;

    const elapsed = now - this.roundStartedAt;
    const lobbyEnd = this.timelineMs.lobbyMs;
    const battleEnd = lobbyEnd + this.timelineMs.battleMs;
    const showdownEnd = battleEnd + this.timelineMs.showdownMs;

    if (elapsed >= showdownEnd) {
      this.endRound(null);
      return;
    }
    if (elapsed >= battleEnd) {
      this.setPhase("showdown");
    } else if (elapsed >= lobbyEnd) {
      this.setPhase("battle");
    } else {
      this.setPhase("lobby");
    }

    if (this.phase !== "showdown") {
      this.safeZoneRadius = this.config.worldRadius;
      return;
    }

    const showdownElapsed = Math.max(0, elapsed - battleEnd);
    const shrinkIntervalMs = Math.max(1, this.config.zoneShrinkIntervalHours * HOUR_MS);
    const totalShrinkSteps = Math.max(
      1,
      Math.ceil(this.timelineMs.showdownMs / shrinkIntervalMs),
    );
    const completedSteps = Math.min(totalShrinkSteps, Math.floor(showdownElapsed / shrinkIntervalMs));
    const shrinkRatio = completedSteps / totalShrinkSteps;
    const radiusRange = this.config.worldRadius - this.config.zoneFinalRadius;

    this.safeZoneRadius = Math.max(
      this.config.zoneFinalRadius,
      this.config.worldRadius - radiusRange * shrinkRatio,
    );
  }

  forcePhase(target: Exclude<GamePhase, "ended">, now = Date.now()): void {
    if (this.roundStartedAt === null) {
      this.roundNumber += 1;
    }

    const lobbyMs = this.timelineMs.lobbyMs;
    const battleMs = this.timelineMs.battleMs;

    if (target === "lobby") {
      this.roundStartedAt = now;
      this.safeZoneRadius = this.config.worldRadius;
      this.winnerId = null;
      this.setPhase("lobby");
      return;
    }

    if (target === "battle") {
      this.roundStartedAt = now - lobbyMs - 1;
      this.safeZoneRadius = this.config.worldRadius;
      this.winnerId = null;
      this.setPhase("battle");
      return;
    }

    // target === "showdown"
    this.roundStartedAt = now - lobbyMs - battleMs - 1;
    this.safeZoneRadius = this.config.worldRadius;
    this.winnerId = null;
    this.setPhase("showdown");
  }

  private getPhaseEndsAt(): number {
    if (this.roundStartedAt === null) return 0;

    const lobbyEnd = this.timelineMs.lobbyMs;
    const battleEnd = lobbyEnd + this.timelineMs.battleMs;
    const showdownEnd = battleEnd + this.timelineMs.showdownMs;

    switch (this.phase) {
      case "lobby":
        return this.roundStartedAt + lobbyEnd;
      case "battle":
        return this.roundStartedAt + battleEnd;
      case "showdown":
        return this.roundStartedAt + showdownEnd;
      case "ended":
        return 0;
      default:
        return 0;
    }
  }

  private setPhase(next: GamePhase): void {
    if (this.phase === next) return;
    const previous = this.phase;
    this.phase = next;
    for (const listener of this.listeners) {
      listener(next, previous);
    }
  }

  private defaultTimelineMs(): PhaseTimelineMs {
    return {
      lobbyMs: Math.max(1, Math.round(this.config.lobbyHours * HOUR_MS)),
      battleMs: Math.max(1, Math.round(this.config.battleHours * HOUR_MS)),
      showdownMs: Math.max(1, Math.round(this.config.showdownHours * HOUR_MS)),
    };
  }

  private resolveTimelineMs(input?: Partial<PhaseTimelineMs>): PhaseTimelineMs {
    const fallback = this.defaultTimelineMs();
    if (!input) return fallback;

    const lobbyRaw = Number(input.lobbyMs);
    const battleRaw = Number(input.battleMs);
    const showdownRaw = Number(input.showdownMs);
    const lobbyMs = Number.isFinite(lobbyRaw) ? Math.max(1, Math.floor(lobbyRaw)) : fallback.lobbyMs;
    const battleMs = Number.isFinite(battleRaw) ? Math.max(1, Math.floor(battleRaw)) : fallback.battleMs;
    const showdownMs = Number.isFinite(showdownRaw) ? Math.max(1, Math.floor(showdownRaw)) : fallback.showdownMs;

    return { lobbyMs, battleMs, showdownMs };
  }
}
