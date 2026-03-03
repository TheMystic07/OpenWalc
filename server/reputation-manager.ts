import type { ReputationRecord } from "./types.js";

const START_REPUTATION = 5;
const MIN_REPUTATION = 0;
const MAX_REPUTATION = 10;

export class ReputationManager {
  private records = new Map<string, ReputationRecord>();

  getReputation(agentId: string): number {
    return this.ensure(agentId).score;
  }

  getRecord(agentId: string): ReputationRecord {
    const record = this.ensure(agentId);
    return { ...record };
  }

  getAll(): ReputationRecord[] {
    return Array.from(this.records.values(), (record) => ({ ...record }));
  }

  recordBetrayal(agentId: string): void {
    const record = this.ensure(agentId);
    record.betrayals += 1;
    record.score = clamp(record.score - 2, MIN_REPUTATION, MAX_REPUTATION);
  }

  recordAllianceDay(agentId: string): void {
    const record = this.ensure(agentId);
    record.allianceDays += 1;
    record.score = clamp(record.score + 0.5, MIN_REPUTATION, MAX_REPUTATION);
  }

  setReputation(agentId: string, score: number): void {
    const record = this.ensure(agentId);
    record.score = clamp(score, MIN_REPUTATION, MAX_REPUTATION);
  }

  reset(): void {
    this.records.clear();
  }

  private ensure(agentId: string): ReputationRecord {
    let record = this.records.get(agentId);
    if (!record) {
      record = {
        agentId,
        score: START_REPUTATION,
        betrayals: 0,
        allianceDays: 0,
      };
      this.records.set(agentId, record);
    }
    return record;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
