import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { NeonRuntimeStore, type RuntimeStateSnapshot } from "../neon-runtime-store.js";

describe("NeonRuntimeStore", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("persists and restores runtime snapshots locally so active rounds can resume after restart", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-runtime-store-"));
    const store = new NeonRuntimeStore({
      localFilePath: join(tempDir, "runtime-state.json"),
    });

    const snapshot: RuntimeStateSnapshot = {
      roomId: "room-1",
      currentRoundId: "room-1:round:3",
      survival: {
        status: "active",
        prizePoolUsd: 2500,
        refusalAgentIds: [],
        summary: "Battle phase is live.",
        roundDurationMs: 300_000,
        roundOneDurationMs: 90_000,
        roundTwoDurationMs: 120_000,
        finalRoundDurationMs: 90_000,
        roundStartedAt: 1_000,
        roundEndsAt: 301_000,
      },
      phase: {
        phase: "battle",
        startedAt: 1_000,
        roundNumber: 3,
        safeZoneRadius: 120,
        lobbyMs: 90_000,
        battleMs: 120_000,
        showdownMs: 90_000,
      },
      participants: ["agent-a", "agent-b"],
      alive: ["agent-a", "agent-b"],
      bannedAgentIds: ["agent-x"],
      betting: {
        closed: false,
        bets: [{
          bettorWallet: "wallet-a",
          agentId: "agent-a",
          amount: 1.25,
          txHash: "tx-1",
          placedAt: 1_500,
        }],
      },
      agents: [
        {
          profile: {
            agentId: "agent-a",
            name: "Agent A",
            walletAddress: "wallet-a",
            pubkey: "",
            bio: "Ready to fight",
            capabilities: ["chat", "battle"],
            combat: {
              wins: 2,
              losses: 1,
              kills: 1,
              deaths: 0,
              guilt: 0,
              refusedPrize: false,
              permanentlyDead: false,
            },
            reputation: 6,
            threatLevel: 2,
            color: "#ff0000",
            joinedAt: 900,
            lastSeen: 1_900,
          },
          position: {
            agentId: "agent-a",
            x: 10,
            y: 0,
            z: 15,
            rotation: 1.2,
            timestamp: 1_950,
          },
          action: "walk",
        },
        {
          profile: {
            agentId: "agent-b",
            name: "Agent B",
            walletAddress: "wallet-b",
            pubkey: "",
            bio: "Holding formation",
            capabilities: ["chat", "battle"],
            reputation: 5,
            threatLevel: 1,
            color: "#00ff00",
            joinedAt: 920,
            lastSeen: 1_920,
          },
          position: {
            agentId: "agent-b",
            x: 14,
            y: 0,
            z: 18,
            rotation: 0.4,
            timestamp: 1_955,
          },
          action: "idle",
        },
      ],
      alliances: [{
        allianceId: "ally-3",
        name: "Alliance 3",
        members: ["agent-a", "agent-b"],
        formedAt: 1_400,
        leader: "agent-a",
      }],
      battles: [{
        battleId: "battle-7",
        participants: ["agent-a", "agent-b"],
        hp: {
          "agent-a": 88,
          "agent-b": 75,
        },
        power: {
          "agent-a": 1,
          "agent-b": 1.1,
        },
        stamina: {
          "agent-a": 80,
          "agent-b": 65,
        },
        intents: {
          "agent-a": "strike",
        },
        intentStreak: {
          "agent-a": { intent: "strike", count: 2 },
          "agent-b": { intent: "guard", count: 1 },
        },
        turn: 3,
        startedAt: 1_200,
        updatedAt: 1_800,
        turnStartedAt: 1_700,
        truceProposals: [],
      }],
      updatedAt: 2_000,
    };

    expect(store.enabled).toBe(true);
    expect(store.mode).toBe("local");

    await store.init();
    await store.save(snapshot);
    const loaded = await store.load("room-1");

    expect(loaded).not.toBeNull();
    expect(loaded?.currentRoundId).toBe(snapshot.currentRoundId);
    expect(loaded?.phase.phase).toBe("battle");
    expect(loaded?.agents.map((agent) => agent.profile.agentId)).toEqual(["agent-a", "agent-b"]);
    expect(loaded?.alliances[0]?.allianceId).toBe("ally-3");
    expect(loaded?.battles[0]?.battleId).toBe("battle-7");
    expect(loaded?.battles[0]?.turnStartedAt).toBe(1_700);
    expect(loaded?.betting.bets[0]?.txHash).toBe("tx-1");
  });
});
