import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type {
  WSServerMessage,
  AgentProfile,
  RoomInfoMessage,
  BattleStateSummary,
} from "./types.js";
import type { ClientManager } from "./client-manager.js";

const MAX_AGENT_ID_LENGTH = 128;
const MAX_WALLET_LENGTH = 128;
const MAX_TX_HASH_LENGTH = 160;
const MAX_VIEWPORT_ABS = 10_000;
const MAX_BET_AMOUNT = 1_000_000;

type UnknownRecord = Record<string, unknown>;

export interface PlaceBetPayload {
  agentId: string;
  amount: number;
  txHash: string;
  wallet: string;
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeAgentId(value: unknown): string | null {
  return asTrimmedString(value, MAX_AGENT_ID_LENGTH);
}

export function parseViewportPayload(value: unknown): { x: number; z: number } | null {
  const record = asRecord(value);
  if (!record) return null;
  const x = asFiniteNumber(record.x);
  const z = asFiniteNumber(record.z);
  if (x === null || z === null) return null;
  if (Math.abs(x) > MAX_VIEWPORT_ABS || Math.abs(z) > MAX_VIEWPORT_ABS) return null;
  return { x, z };
}

export function parseFollowPayload(value: unknown): { agentId: string } | null {
  const record = asRecord(value);
  if (!record) return null;
  const agentId = normalizeAgentId(record.agentId);
  if (!agentId) return null;
  return { agentId };
}

export function parsePlaceBetPayload(value: unknown): PlaceBetPayload | null {
  const record = asRecord(value);
  if (!record) return null;

  const agentId = normalizeAgentId(record.agentId);
  const wallet = asTrimmedString(record.wallet, MAX_WALLET_LENGTH);
  const txHash = asTrimmedString(record.txHash, MAX_TX_HASH_LENGTH);
  const amount = asFiniteNumber(record.amount);

  if (!agentId || !wallet || !txHash || amount === null) return null;
  if (amount <= 0 || amount > MAX_BET_AMOUNT) return null;
  if (/\s/.test(wallet) || /\s/.test(txHash)) return null;

  return { agentId, amount, txHash, wallet };
}

/**
 * WebSocket bridge for browser clients.
 *
 * The game loop now owns broadcasting (AOI-filtered).
 * This bridge only handles:
 *   - Connection lifecycle (add/remove from ClientManager)
 *   - Client-initiated requests (profiles, viewport updates, room info)
 *   - Sending the initial snapshot on connect
 */
export class WSBridge {
  private wss: WebSocketServer;
  private clientManager: ClientManager;
  private getProfiles: () => AgentProfile[];
  private getProfile: (id: string) => AgentProfile | undefined;
  private getBattles: () => BattleStateSummary[];
  private getRoomInfo: (() => RoomInfoMessage) | null;
  private onPlaceBet: ((input: {
    agentId: string;
    amount: number;
    txHash: string;
    wallet: string;
  }) => unknown | Promise<unknown>) | null;

  constructor(
    server: Server,
    clientManager: ClientManager,
    opts: {
      getProfiles: () => AgentProfile[];
      getProfile: (id: string) => AgentProfile | undefined;
      getBattles?: () => BattleStateSummary[];
      getRoomInfo?: () => RoomInfoMessage;
      onPlaceBet?: (input: {
        agentId: string;
        amount: number;
        txHash: string;
        wallet: string;
      }) => unknown | Promise<unknown>;
    }
  ) {
    this.clientManager = clientManager;
    this.getProfiles = opts.getProfiles;
    this.getProfile = opts.getProfile;
    this.getBattles = opts.getBattles ?? (() => []);
    this.getRoomInfo = opts.getRoomInfo ?? null;
    this.onPlaceBet = opts.onPlaceBet ?? null;

    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const client = this.clientManager.addClient(ws);
      console.log(`[ws] Client ${client.id} connected (${this.clientManager.size} total)`);

      // Parse ?agent= param for preview mode follow
      const url = new URL(req.url ?? "/", "http://localhost");
      const followAgent = normalizeAgentId(url.searchParams.get("agent"));
      if (followAgent) {
        this.clientManager.setFollowAgent(ws, followAgent);
      }

      // Send room info immediately on connect
      if (this.getRoomInfo) {
        this.send(ws, { type: "roomInfo", info: this.getRoomInfo() });
      }
      this.send(ws, { type: "battleState", battles: this.getBattles() });

      // Game loop will send the first snapshot on the next tick
      // (client.lastAckTick === 0 triggers full snapshot)

      ws.on("message", (raw) => {
        // Enforce message size limit (64KB) like the HTTP side
        const rawBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (rawBuf.byteLength > 64 * 1024) {
          return; // Drop oversized messages
        }
        let msg: unknown;
        try {
          msg = JSON.parse(rawBuf.toString()) as unknown;
        } catch {
          return; // Ignore malformed JSON
        }
        try {
          this.handleClientMessage(ws, msg);
        } catch (err) {
          console.error("[ws] Error handling message:", err);
        }
      });

      ws.on("close", () => {
        this.clientManager.removeClient(ws);
        console.log(`[ws] Client disconnected (${this.clientManager.size} total)`);
      });
    });
  }

  private handleClientMessage(ws: WebSocket, msg: unknown): void {
    const payload = asRecord(msg);
    const type = typeof payload?.type === "string" ? payload.type : null;
    if (!type) return;

    switch (type) {
      case "subscribe":
        // Client wants a fresh snapshot — reset ack to trigger full snapshot next tick
        {
          const state = this.clientManager.getByWs(ws);
          if (state) state.lastAckTick = 0;
        }
        break;

      case "requestProfiles":
        this.send(ws, {
          type: "profiles",
          profiles: this.getProfiles(),
        });
        break;

      case "requestProfile":
        if (payload) {
          const agentId = normalizeAgentId(payload.agentId);
          if (!agentId) break;
          const profile = this.getProfile(agentId);
          if (profile) {
            this.send(ws, { type: "profile", profile });
          }
        }
        break;

      case "viewport":
        // Client reports camera position for AOI filtering
        {
          const viewport = parseViewportPayload(payload);
          if (!viewport) break;
          this.clientManager.updateViewport(ws, viewport.x, viewport.z);
        }
        break;

      case "follow":
        // Client wants to follow a specific agent
        {
          const follow = parseFollowPayload(payload);
          if (!follow) break;
          this.clientManager.setFollowAgent(ws, follow.agentId);
        }
        break;

      case "requestRoomInfo":
        if (this.getRoomInfo) {
          this.send(ws, { type: "roomInfo", info: this.getRoomInfo() });
        }
        break;

      case "requestBattles":
        this.send(ws, { type: "battleState", battles: this.getBattles() });
        break;

      case "placeBet":
        if (!this.onPlaceBet) {
          this.send(ws, {
            type: "commandResult",
            requestType: "placeBet",
            result: { ok: false, error: "betting_not_enabled" },
          });
          break;
        }
        {
          const placeBet = parsePlaceBetPayload(payload);
          if (!placeBet) {
            this.send(ws, {
              type: "commandResult",
              requestType: "placeBet",
              result: { ok: false, error: "invalid_place_bet_payload" },
            });
            break;
          }
          void Promise.resolve(this.onPlaceBet(placeBet))
            .then((result) => {
              this.send(ws, {
                type: "commandResult",
                requestType: "placeBet",
                result,
              });
            })
            .catch((error) => {
              this.send(ws, {
                type: "commandResult",
                requestType: "placeBet",
                result: { ok: false, error: `place_bet_failed:${String(error)}` },
              });
            });
        }
        break;
    }
  }

  private send(ws: WebSocket, msg: WSServerMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    } catch (error) {
      console.warn("[ws] send failed:", error);
    }
  }
}
