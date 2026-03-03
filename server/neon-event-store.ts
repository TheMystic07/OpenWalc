import { neon } from "@neondatabase/serverless";

export type StoredEventType =
  | "chat"
  | "whisper"
  | "battle_end"
  | "battle_start"
  | "alliance"
  | "phase"
  | "join"
  | "leave"
  | "bet"
  | "system";

export interface StoredEvent {
  id?: number;
  roundId: string;
  eventType: StoredEventType;
  agentId: string;
  targetAgentId?: string | null;
  payload: Record<string, unknown>;
  timestamp: number;
}

interface NeonEventRow {
  id: string | number;
  round_id: string;
  event_type: string;
  agent_id: string;
  target_agent_id: string | null;
  payload: string | Record<string, unknown>;
  created_at: string | number;
}

export class NeonEventStore {
  private readonly sql: ReturnType<typeof neon> | null;
  readonly enabled: boolean;

  constructor(databaseUrl = process.env.NEON_DATABASE_URL) {
    if (!databaseUrl) {
      this.sql = null;
      this.enabled = false;
      return;
    }
    this.sql = neon(databaseUrl);
    this.enabled = true;
  }

  async init(): Promise<void> {
    if (!this.sql) return;
    await this.sql`
      CREATE TABLE IF NOT EXISTS openclaw_events (
        id BIGSERIAL PRIMARY KEY,
        round_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        target_agent_id TEXT,
        payload JSONB NOT NULL DEFAULT '{}',
        created_at BIGINT NOT NULL
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_openclaw_events_round
      ON openclaw_events(round_id, created_at DESC)
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_openclaw_events_type
      ON openclaw_events(round_id, event_type)
    `;
  }

  async save(event: StoredEvent): Promise<void> {
    if (!this.sql) return;
    await this.sql`
      INSERT INTO openclaw_events (
        round_id, event_type, agent_id, target_agent_id, payload, created_at
      ) VALUES (
        ${event.roundId},
        ${event.eventType},
        ${event.agentId},
        ${event.targetAgentId ?? null},
        ${JSON.stringify(event.payload)},
        ${event.timestamp}
      )
    `;
  }

  async saveBatch(events: StoredEvent[]): Promise<void> {
    if (!this.sql || events.length === 0) return;
    // Use parameterized inserts to avoid SQL injection; Neon handles connection pooling
    const promises = events.map((e) =>
      this.sql!`
        INSERT INTO openclaw_events (round_id, event_type, agent_id, target_agent_id, payload, created_at)
        VALUES (${e.roundId}, ${e.eventType}, ${e.agentId}, ${e.targetAgentId ?? null}, ${JSON.stringify(e.payload)}::jsonb, ${e.timestamp})
      `
    );
    await Promise.allSettled(promises);
  }

  async listEvents(roundId: string, opts?: {
    eventType?: StoredEventType;
    since?: number;
    limit?: number;
  }): Promise<StoredEvent[]> {
    if (!this.sql) return [];
    const limit = Math.min(opts?.limit ?? 200, 1000);

    let result;
    if (opts?.eventType && opts?.since) {
      result = await this.sql`
        SELECT id, round_id, event_type, agent_id, target_agent_id, payload, created_at
        FROM openclaw_events
        WHERE round_id = ${roundId}
          AND event_type = ${opts.eventType}
          AND created_at > ${opts.since}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else if (opts?.eventType) {
      result = await this.sql`
        SELECT id, round_id, event_type, agent_id, target_agent_id, payload, created_at
        FROM openclaw_events
        WHERE round_id = ${roundId}
          AND event_type = ${opts.eventType}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else if (opts?.since) {
      result = await this.sql`
        SELECT id, round_id, event_type, agent_id, target_agent_id, payload, created_at
        FROM openclaw_events
        WHERE round_id = ${roundId}
          AND created_at > ${opts.since}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else {
      result = await this.sql`
        SELECT id, round_id, event_type, agent_id, target_agent_id, payload, created_at
        FROM openclaw_events
        WHERE round_id = ${roundId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    }

    const rows = Array.isArray(result) ? (result as NeonEventRow[]) : [];
    return rows.map(toStoredEvent);
  }

  async countEvents(roundId: string): Promise<number> {
    if (!this.sql) return 0;
    const result = await this.sql`
      SELECT COUNT(*)::int AS cnt FROM openclaw_events WHERE round_id = ${roundId}
    `;
    return (result as Array<{ cnt: number }>)?.[0]?.cnt ?? 0;
  }
}

function toStoredEvent(row: NeonEventRow): StoredEvent {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return {
    id: Number(row.id),
    roundId: row.round_id,
    eventType: row.event_type as StoredEventType,
    agentId: row.agent_id,
    targetAgentId: row.target_agent_id,
    payload: payload ?? {},
    timestamp: Number(row.created_at),
  };
}
