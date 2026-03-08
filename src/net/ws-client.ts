type Handler = (data: unknown) => void;

interface QueuedOutboundMessage {
  raw: string;
  type: string | null;
}

const MAX_OUTBOUND_QUEUE = 128;
const REPLACEABLE_QUEUE_TYPES = new Set([
  "follow",
  "requestBattles",
  "requestProfiles",
  "requestRoomInfo",
  "viewport",
]);

/**
 * WebSocket client with auto-reconnection.
 * Connects to the single world server through the local /ws endpoint.
 */
export class WSClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 10000;
  private url: string;
  private outboundQueue: QueuedOutboundMessage[] = [];

  constructor() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${proto}//${window.location.host}/ws`;
  }

  /** Register an event handler */
  on(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /** Connect to the world server */
  connect(): void {
    this.doConnect();
  }

  /** Send a message to the server (buffers if socket not open) */
  send(msg: Record<string, unknown>): void {
    const raw = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this.enqueueOutboundMessage({
        raw,
        type: typeof msg.type === "string" ? msg.type : null,
      });
    }
  }

  /** Report camera viewport position for server-side AOI filtering */
  reportViewport(x: number, z: number): void {
    this.send({ type: "viewport", x, z });
  }

  /** Request full profiles list (not AOI-filtered) */
  requestProfiles(): void {
    this.send({ type: "requestProfiles" });
  }

  /** Request active battles list */
  requestBattles(): void {
    this.send({ type: "requestBattles" });
  }

  /** Request current room info snapshot */
  requestRoomInfo(): void {
    this.send({ type: "requestRoomInfo" });
  }

  /** Place a spectator bet through the websocket channel. */
  placeBet(agentId: string, amount: number, txHash: string, wallet: string): void {
    this.send({ type: "placeBet", agentId, amount, txHash, wallet });
  }

  private doConnect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("[ws] Connected to world server");
      this.reconnectDelay = 1000;
      // Flush any messages buffered while disconnected
      for (const queued of this.outboundQueue) {
        this.ws!.send(queued.raw);
      }
      this.outboundQueue.length = 0;
      this.emit("connected", {});
    };

    this.ws.onmessage = (event) => {
      try {
        const raw = event.data;
        if (typeof raw !== "string" || raw.length > 1_000_000) return;
        const data = JSON.parse(raw);
        if (
          typeof data === "object" &&
          data !== null &&
          typeof data.type === "string" &&
          data.type.length > 0
        ) {
          this.emit(data.type, data);
        }
      } catch {
        // Ignore malformed
      }
    };

    this.ws.onclose = () => {
      console.log("[ws] Disconnected, reconnecting...");
      this.emit("disconnected", {});
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 1.5,
      this.maxReconnectDelay
    );
  }

  private enqueueOutboundMessage(message: QueuedOutboundMessage): void {
    if (message.type && REPLACEABLE_QUEUE_TYPES.has(message.type)) {
      this.outboundQueue = this.outboundQueue.filter((queued) => queued.type !== message.type);
    }

    this.outboundQueue.push(message);
    if (this.outboundQueue.length > MAX_OUTBOUND_QUEUE) {
      this.outboundQueue.splice(0, this.outboundQueue.length - MAX_OUTBOUND_QUEUE);
    }
  }

  private emit(type: string, data: unknown): void {
    const list = this.handlers.get(type);
    if (list) {
      for (const handler of list) {
        handler(data);
      }
    }
  }
}
