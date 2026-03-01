import { WebSocket } from "ws";
import type { WorldState } from "./world-state.js";
import type { SpatialGrid } from "./spatial-index.js";
import type { CommandQueue } from "./command-queue.js";
import { ClientManager, AOI_RADIUS } from "./client-manager.js";
import type { WorldMessage, AgentState, WSServerMessage } from "./types.js";
import { CHAT_RANGE } from "./types.js";
import type { NostrWorld } from "./nostr-world.js";

/** Server tick rate in Hz */
export const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

/** How often to send full snapshots (every N ticks = every 5 seconds) */
const FULL_SNAPSHOT_INTERVAL = TICK_RATE * 5;

export class GameLoop {
  private tickCount = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private tickHooks: Array<(tickCount: number) => void> = [];
  private eventHooks: Array<(events: WorldMessage[]) => void> = [];

  /** Events that happened this tick — broadcast to relevant clients */
  private tickEvents: WorldMessage[] = [];

  constructor(
    private worldState: WorldState,
    private spatialGrid: SpatialGrid,
    private commandQueue: CommandQueue,
    private clientManager: ClientManager,
    private nostr: NostrWorld,
  ) {}

  /** Register a function called every tick */
  onTick(hook: (tickCount: number) => void): void {
    this.tickHooks.push(hook);
  }

  /** Register a function called with each tick's events after they are applied */
  onEvents(hook: (events: WorldMessage[]) => void): void {
    this.eventHooks.push(hook);
  }

  get currentTick(): number {
    return this.tickCount;
  }

  start(): void {
    console.log(`[game] Starting game loop at ${TICK_RATE}Hz (${TICK_MS}ms/tick)`);
    this.intervalId = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private tick(): void {
    try {
      this.tickCount++;
      this.tickEvents = [];

      // 0. Run registered tick hooks
      for (const [index, hook] of this.tickHooks.entries()) {
        try {
          hook(this.tickCount);
        } catch (err) {
          console.error(`[game] tick hook #${index + 1} failed on tick ${this.tickCount}:`, err);
        }
      }

      // 1. Drain pending commands from the queue
      const commands = this.commandQueue.drain();

      // 2. Apply commands to world state, collect events
      for (const cmd of commands) {
        try {
          this.worldState.apply(cmd);
          this.tickEvents.push(cmd);

          // Clean up rate-limit bucket when agent leaves
          if (cmd.worldType === "leave") {
            this.commandQueue.pruneAgent(cmd.agentId);
          }

          // Publish to Nostr relay (non-blocking)
          this.nostr.publish(cmd).catch((err) => {
            console.warn("[game] Nostr publish error:", err);
          });
        } catch (err) {
          console.error(
            `[game] Failed to apply command ${cmd.worldType} for ${cmd.agentId} on tick ${this.tickCount}:`,
            err,
          );
        }
      }

      // 2b. Fire event hooks for persistence / side-effects
      if (this.tickEvents.length > 0) {
        for (const [index, hook] of this.eventHooks.entries()) {
          try {
            hook(this.tickEvents);
          } catch (err) {
            console.error(`[game] event hook #${index + 1} failed on tick ${this.tickCount}:`, err);
          }
        }
      }

      // 3. Rebuild spatial index from current positions
      this.spatialGrid.rebuild(this.worldState.getAllPositions());

      // 4. Update client viewports from followed agents
      for (const client of this.clientManager.getAllClients()) {
        if (client.followAgent) {
          const pos = this.worldState.getPosition(client.followAgent);
          if (pos) {
            client.viewX = pos.x;
            client.viewZ = pos.z;
          }
        }
      }

      // 5. Send updates to each client (AOI-filtered)
      const isFullSnapshotTick = this.tickCount % FULL_SNAPSHOT_INTERVAL === 0;

      for (const client of this.clientManager.getAllClients()) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;

        const isFirstSnapshot = client.lastAckTick === 0;
        if (isFullSnapshotTick || isFirstSnapshot) {
          // First snapshot is unfiltered so client sees ALL agents
          this.sendSnapshot(client, isFirstSnapshot);
          if (isFirstSnapshot) {
            client.lastAckTick = this.tickCount;
          }
        } else {
          this.sendTickEvents(client);
        }
      }
    } catch (err) {
      console.error(`[game] Tick ${this.tickCount} error:`, err);
    }
  }

  /** Send snapshot to a client. First snapshot is unfiltered; subsequent are AOI-filtered. */
  private sendSnapshot(client: { ws: WebSocket; viewX: number; viewZ: number }, unfiltered = false): void {
    const allStates = this.worldState.snapshot();

    let agents: typeof allStates;
    if (unfiltered) {
      agents = allStates;
    } else {
      const nearbyAgents = this.spatialGrid.queryRadius(
        client.viewX,
        client.viewZ,
        AOI_RADIUS
      );
      agents = allStates.filter((s) => nearbyAgents.has(s.profile.agentId));
    }

    const msg: WSServerMessage = {
      type: "snapshot",
      agents,
    };
    this.safeSend(client.ws, msg);
  }

  /** Send only this tick's events that are within client's AOI */
  private sendTickEvents(client: { ws: WebSocket; viewX: number; viewZ: number }): void {
    if (this.tickEvents.length === 0) return;

    const nearbyAgents = this.spatialGrid.queryRadius(
      client.viewX,
      client.viewZ,
      AOI_RADIUS
    );

    for (const event of this.tickEvents) {
      // Whisper events are intentionally not broadcast via the public stream.
      if (event.worldType === "whisper") continue;

      // Global events always sent regardless of distance
      const isGlobal =
        event.worldType === "join" ||
        event.worldType === "leave" ||
        event.worldType === "profile" ||
        event.worldType === "battle" ||
        event.worldType === "alliance" ||
        event.worldType === "phase" ||
        event.worldType === "territory" ||
        event.worldType === "bet" ||
        event.worldType === "zone_damage";

      // Chat & emote are proximity-filtered: only viewers near the speaker
      const isSpatialMessage =
        event.worldType === "chat" || event.worldType === "emote";

      if (isSpatialMessage) {
        // Deliver chat/emote only to clients whose viewport is near the speaker
        const speakerPos = this.worldState.getPosition(event.agentId);
        if (speakerPos) {
          const dx = client.viewX - speakerPos.x;
          const dz = client.viewZ - speakerPos.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist <= CHAT_RANGE + AOI_RADIUS) {
            const msg: WSServerMessage = { type: "world", message: event };
            this.safeSend(client.ws, msg);
          }
        }
      } else if (isGlobal || nearbyAgents.has(event.agentId)) {
        const msg: WSServerMessage = { type: "world", message: event };
        this.safeSend(client.ws, msg);
      }
    }
  }

  /** Safe JSON send — never throws */
  private safeSend(ws: WebSocket, msg: WSServerMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      console.warn("[game] Send error:", err);
    }
  }
}
