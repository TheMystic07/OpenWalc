import { WORLD_SIZE, type WorldMessage } from "./types.js";

/** Max agent commands per second (rate limit) */
const MAX_CMD_RATE = 20;
const RATE_WINDOW_MS = 1000;
const RATE_BUCKET_STALE_MS = RATE_WINDOW_MS * 5;
const RATE_CLEANUP_EVERY = 256;
const MAX_PENDING_COMMANDS = 10_000;
const MAX_CHAT_LENGTH = 500;

/** World half-size (bounds check) */
const WORLD_HALF = WORLD_SIZE / 2;

/** Obstacle definitions for server-side collision */
export interface Obstacle {
  x: number;
  z: number;
  radius: number;
}

export class CommandQueue {
  /** Pending commands to be consumed by the game loop */
  private pending: WorldMessage[] = [];

  /** Rate limit tracking: agentId → timestamps + read head for O(1)-ish pruning */
  private rateBuckets = new Map<string, { timestamps: number[]; head: number; lastSeen: number }>();
  private rateChecks = 0;

  /** Known obstacles for collision validation */
  private obstacles: Obstacle[] = [];

  setObstacles(obs: Obstacle[]): void {
    this.obstacles = obs;
  }

  /**
   * Enqueue a command from an agent. Returns false if rate-limited or invalid.
   * The game loop drains the queue each tick.
   */
  enqueue(msg: WorldMessage): { ok: boolean; reason?: string } {
    if (typeof msg.agentId !== "string" || msg.agentId.trim().length === 0) {
      return { ok: false, reason: "invalid_agent_id" };
    }
    if (!Number.isFinite(msg.timestamp)) {
      return { ok: false, reason: "invalid_timestamp" };
    }

    // Rate limit only high-frequency player actions.
    const isRateLimitedType =
      msg.worldType === "position" ||
      msg.worldType === "action" ||
      msg.worldType === "chat" ||
      msg.worldType === "emote";
    if (isRateLimitedType && !this.checkRate(msg.agentId)) {
      return { ok: false, reason: "rate_limited" };
    }

    // Validate position commands
    if (msg.worldType === "position") {
      if (
        !Number.isFinite(msg.x) ||
        !Number.isFinite(msg.y) ||
        !Number.isFinite(msg.z) ||
        !Number.isFinite(msg.rotation)
      ) {
        return { ok: false, reason: "invalid_position" };
      }

      // Bounds check
      if (Math.abs(msg.x) > WORLD_HALF || Math.abs(msg.z) > WORLD_HALF) {
        return { ok: false, reason: "out_of_bounds" };
      }

      // Obstacle collision check
      for (const obs of this.obstacles) {
        const dx = msg.x - obs.x;
        const dz = msg.z - obs.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < obs.radius + 1.0) {
          return { ok: false, reason: "collision" };
        }
      }
    }

    // Chat text length limit
    if (msg.worldType === "chat") {
      if (typeof msg.text !== "string") {
        return { ok: false, reason: "invalid_text" };
      }
      if (msg.text.length > MAX_CHAT_LENGTH) {
        return { ok: false, reason: "text_too_long" };
      }
    }

    if (this.pending.length >= MAX_PENDING_COMMANDS) {
      return { ok: false, reason: "queue_full" };
    }

    this.pending.push(msg);
    return { ok: true };
  }

  /** Drain all pending commands (called by game loop each tick) */
  drain(): WorldMessage[] {
    const cmds = this.pending;
    this.pending = [];
    return cmds;
  }

  /** Check rate limit. Returns true if allowed. */
  private checkRate(agentId: string): boolean {
    const now = Date.now();
    let bucket = this.rateBuckets.get(agentId);
    if (!bucket) {
      bucket = { timestamps: [], head: 0, lastSeen: now };
      this.rateBuckets.set(agentId, bucket);
    }

    // Remove old timestamps outside the window
    const cutoff = now - RATE_WINDOW_MS;
    while (bucket.head < bucket.timestamps.length && bucket.timestamps[bucket.head] < cutoff) {
      bucket.head += 1;
    }

    if (bucket.timestamps.length - bucket.head >= MAX_CMD_RATE) {
      bucket.lastSeen = now;
      return false;
    }

    bucket.timestamps.push(now);
    bucket.lastSeen = now;

    // Compact periodically so arrays do not grow forever.
    if (bucket.head > 32 && bucket.head * 2 >= bucket.timestamps.length) {
      bucket.timestamps = bucket.timestamps.slice(bucket.head);
      bucket.head = 0;
    }

    this.rateChecks += 1;
    if (this.rateChecks % RATE_CLEANUP_EVERY === 0) {
      this.pruneStaleRateBuckets(now);
    }

    return true;
  }

  private pruneStaleRateBuckets(now: number): void {
    const staleCutoff = now - RATE_BUCKET_STALE_MS;
    for (const [agentId, bucket] of this.rateBuckets.entries()) {
      if (bucket.lastSeen < staleCutoff) {
        this.rateBuckets.delete(agentId);
      }
    }
  }

  /** Remove rate-limit bucket for an agent that has left */
  pruneAgent(agentId: string): void {
    this.rateBuckets.delete(agentId);
  }
}
