import type { Alliance, AllianceProposal } from "./types.js";

const PROPOSAL_TIMEOUT_MS = 30_000;

export type AllianceProposeResult =
  | { ok: true; proposalId: string }
  | { ok: false; error: string };

export type AllianceAcceptResult =
  | { ok: true; alliance: Alliance }
  | { ok: false; error: string };

export type AllianceBreakResult =
  | { ok: true; betrayal: boolean; formerAllies: string[]; allianceId: string }
  | { ok: false; error: string };

let nextAllianceId = 1;
let nextProposalId = 1;

function makeAllianceId(): string {
  return `ally-${nextAllianceId++}`;
}

function makeProposalId(): string {
  return `prop-${nextProposalId++}`;
}

export class AllianceManager {
  private alliances = new Map<string, Alliance>();
  private agentAlliance = new Map<string, string>();
  private proposals = new Map<string, AllianceProposal>();
  private maxSize = 4;

  setMaxSize(size: number): void {
    this.maxSize = Math.max(2, Math.floor(size));
  }

  getMaxSize(): number {
    return this.maxSize;
  }

  propose(fromAgent: string, toAgent: string, now = Date.now(), fromGuilt = 0): AllianceProposeResult {
    if (!fromAgent || !toAgent) return { ok: false, error: "Invalid agent id" };
    if (fromAgent === toAgent) return { ok: false, error: "Cannot ally with self" };
    if (fromGuilt > 5) {
      return {
        ok: false,
        error: "Agent is ruthless (guilt > 5), cannot propose alliances",
      };
    }
    if (this.areAllies(fromAgent, toAgent)) {
      return { ok: false, error: "Agents are already allies" };
    }

    // Reject duplicate in either direction while pending.
    for (const proposal of this.proposals.values()) {
      const sameDirection =
        proposal.fromAgent === fromAgent && proposal.toAgent === toAgent;
      const oppositeDirection =
        proposal.fromAgent === toAgent && proposal.toAgent === fromAgent;
      if (sameDirection || oppositeDirection) {
        return { ok: false, error: "Proposal already pending" };
      }
    }

    const fromAllianceId = this.agentAlliance.get(fromAgent);
    if (fromAllianceId) {
      const fromAlliance = this.alliances.get(fromAllianceId);
      if (fromAlliance && fromAlliance.members.length >= this.maxSize) {
        return { ok: false, error: "Alliance is full" };
      }
    }

    const proposalId = makeProposalId();
    this.proposals.set(proposalId, {
      proposalId,
      fromAgent,
      toAgent,
      expiresAt: now + PROPOSAL_TIMEOUT_MS,
    });

    return { ok: true, proposalId };
  }

  accept(acceptingAgent: string, proposingAgent: string, now = Date.now()): AllianceAcceptResult {
    const proposal = this.findProposal(proposingAgent, acceptingAgent);
    if (!proposal) return { ok: false, error: "No pending proposal found" };
    if (proposal.expiresAt <= now) {
      this.proposals.delete(proposal.proposalId);
      return { ok: false, error: "Proposal has expired" };
    }
    this.proposals.delete(proposal.proposalId);

    if (this.agentAlliance.has(acceptingAgent)) {
      return { ok: false, error: "Already in an alliance" };
    }

    const proposerAllianceId = this.agentAlliance.get(proposingAgent);
    if (proposerAllianceId) {
      const alliance = this.alliances.get(proposerAllianceId);
      if (!alliance) return { ok: false, error: "Alliance not found" };
      if (alliance.members.length >= this.maxSize) {
        return { ok: false, error: "Alliance is full" };
      }
      alliance.members.push(acceptingAgent);
      this.agentAlliance.set(acceptingAgent, alliance.allianceId);
      return { ok: true, alliance: this.cloneAlliance(alliance) };
    }

    const alliance: Alliance = {
      allianceId: makeAllianceId(),
      name: `Alliance ${nextAllianceId - 1}`,
      members: [proposingAgent, acceptingAgent],
      formedAt: now,
      leader: proposingAgent,
    };
    this.alliances.set(alliance.allianceId, alliance);
    this.agentAlliance.set(proposingAgent, alliance.allianceId);
    this.agentAlliance.set(acceptingAgent, alliance.allianceId);
    return { ok: true, alliance: this.cloneAlliance(alliance) };
  }

  decline(decliningAgent: string, proposingAgent: string): { ok: boolean } {
    const proposal = this.findProposal(proposingAgent, decliningAgent);
    if (!proposal) return { ok: false };
    this.proposals.delete(proposal.proposalId);
    return { ok: true };
  }

  breakAlliance(agentId: string): AllianceBreakResult {
    const allianceId = this.agentAlliance.get(agentId);
    if (!allianceId) return { ok: false, error: "Not in an alliance" };

    const alliance = this.alliances.get(allianceId);
    if (!alliance) return { ok: false, error: "Alliance not found" };

    const formerAllies = alliance.members.filter((memberId) => memberId !== agentId);
    alliance.members = formerAllies;
    this.agentAlliance.delete(agentId);

    // Dissolve alliances that drop below two members.
    if (alliance.members.length < 2) {
      for (const memberId of alliance.members) {
        this.agentAlliance.delete(memberId);
      }
      this.alliances.delete(allianceId);
    }

    return {
      ok: true,
      betrayal: formerAllies.length > 0,
      formerAllies,
      allianceId,
    };
  }

  areAllies(agentA: string, agentB: string): boolean {
    const a = this.agentAlliance.get(agentA);
    const b = this.agentAlliance.get(agentB);
    return a !== undefined && a === b;
  }

  getAlliance(agentId: string): Alliance | null {
    const allianceId = this.agentAlliance.get(agentId);
    if (!allianceId) return null;
    const alliance = this.alliances.get(allianceId);
    return alliance ? this.cloneAlliance(alliance) : null;
  }

  getAllAlliances(): Alliance[] {
    return Array.from(this.alliances.values(), (alliance) => this.cloneAlliance(alliance));
  }

  restore(alliances: Alliance[] | null | undefined): void {
    this.alliances.clear();
    this.agentAlliance.clear();
    this.proposals.clear();

    let nextIdFloor = 1;
    if (!Array.isArray(alliances)) {
      nextAllianceId = nextIdFloor;
      return;
    }

    for (const rawAlliance of alliances) {
      if (!rawAlliance || typeof rawAlliance !== "object") continue;
      const allianceId = typeof rawAlliance.allianceId === "string" ? rawAlliance.allianceId.trim() : "";
      const name = typeof rawAlliance.name === "string" ? rawAlliance.name.trim() : "";
      const leader = typeof rawAlliance.leader === "string" ? rawAlliance.leader.trim() : "";
      const formedAt = Number(rawAlliance.formedAt);
      const members = Array.isArray(rawAlliance.members)
        ? Array.from(new Set(
          rawAlliance.members
            .filter((member): member is string => typeof member === "string")
            .map((member) => member.trim())
            .filter((member) => member.length > 0),
        ))
        : [];

      if (!allianceId || !name || members.length < 2 || !leader || !members.includes(leader)) {
        continue;
      }
      if (!Number.isFinite(formedAt) || formedAt <= 0) continue;
      if (members.some((member) => this.agentAlliance.has(member))) continue;

      const alliance: Alliance = {
        allianceId,
        name,
        members,
        formedAt: Math.floor(formedAt),
        leader,
      };
      this.alliances.set(allianceId, alliance);
      for (const member of members) {
        this.agentAlliance.set(member, allianceId);
      }
      nextIdFloor = Math.max(nextIdFloor, this.getNextIdFloor(allianceId));
    }

    nextAllianceId = nextIdFloor;
  }

  removeAgent(agentId: string): void {
    // Clean up any pending proposals involving this agent
    for (const [proposalId, proposal] of this.proposals.entries()) {
      if (proposal.fromAgent === agentId || proposal.toAgent === agentId) {
        this.proposals.delete(proposalId);
      }
    }

    const allianceId = this.agentAlliance.get(agentId);
    if (!allianceId) return;

    const alliance = this.alliances.get(allianceId);
    if (!alliance) {
      this.agentAlliance.delete(agentId);
      return;
    }

    alliance.members = alliance.members.filter((memberId) => memberId !== agentId);
    this.agentAlliance.delete(agentId);

    if (alliance.members.length < 2) {
      for (const memberId of alliance.members) {
        this.agentAlliance.delete(memberId);
      }
      this.alliances.delete(allianceId);
    }
  }

  expireProposals(now = Date.now()): string[] {
    const expired: string[] = [];
    for (const [proposalId, proposal] of this.proposals.entries()) {
      if (proposal.expiresAt <= now) {
        this.proposals.delete(proposalId);
        expired.push(proposalId);
      }
    }
    return expired;
  }

  enforceMaxSize(): { dissolved: Alliance[]; kept: Alliance[] } {
    const dissolved: Alliance[] = [];
    const kept: Alliance[] = [];

    for (const alliance of this.alliances.values()) {
      if (alliance.members.length <= this.maxSize) {
        kept.push(this.cloneAlliance(alliance));
        continue;
      }

      dissolved.push(this.cloneAlliance(alliance));
      const removed = alliance.members.slice(this.maxSize);
      alliance.members = alliance.members.slice(0, this.maxSize);

      for (const removedAgent of removed) {
        this.agentAlliance.delete(removedAgent);
      }

      if (alliance.members.length < 2) {
        for (const memberId of alliance.members) {
          this.agentAlliance.delete(memberId);
        }
        this.alliances.delete(alliance.allianceId);
      } else {
        kept.push(this.cloneAlliance(alliance));
      }
    }

    return { dissolved, kept };
  }

  reset(): void {
    this.alliances.clear();
    this.agentAlliance.clear();
    this.proposals.clear();
    this.maxSize = 4;
  }

  private findProposal(fromAgent: string, toAgent: string): AllianceProposal | null {
    for (const proposal of this.proposals.values()) {
      if (proposal.fromAgent === fromAgent && proposal.toAgent === toAgent) {
        return proposal;
      }
    }
    return null;
  }

  private cloneAlliance(alliance: Alliance): Alliance {
    return { ...alliance, members: [...alliance.members] };
  }

  private getNextIdFloor(allianceId: string): number {
    const match = /^ally-(\d+)$/.exec(allianceId);
    if (!match) return nextAllianceId;
    return Math.max(1, Number(match[1]) + 1);
  }
}
