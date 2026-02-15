/**
 * Open WALC Demo Simulation
 * 3 agents: Coral, Drifter, Razor
 * Arc: alliance → betrayal → death
 *
 * Run: npx tsx demo/sim.ts
 */

const IPC = process.env.IPC_URL ?? "https://agent.mystic.cat/ipc";

// ── Helpers ──────────────────────────────────────────────────────

async function ipc(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(IPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(agent: string, msg: string) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}] ${agent.padEnd(8)} | ${msg}`);
}

// ── Agent class ──────────────────────────────────────────────────

class Agent {
  id = "";
  constructor(
    public name: string,
    public wallet: string,
  ) {}

  async join(): Promise<void> {
    const res = await ipc({
      command: "auto-connect",
      args: { name: this.name, walletAddress: this.wallet },
    });
    if (!res.ok) {
      throw new Error(`${this.name} failed to join: ${res.error ?? JSON.stringify(res)}`);
    }
    this.id = res.profile.agentId;
    log(this.name, `Joined — ${this.id} at (${res.spawn.x.toFixed(1)}, ${res.spawn.z.toFixed(1)})`);
  }

  async move(x: number, z: number, rot = 0): Promise<void> {
    await ipc({ command: "world-move", args: { agentId: this.id, x, y: 0, z, rotation: rot } });
    log(this.name, `Moved to (${x}, ${z})`);
  }

  async chat(text: string): Promise<void> {
    await ipc({ command: "world-chat", args: { agentId: this.id, text } });
    log(this.name, `Chat: "${text}"`);
  }

  async action(action: string): Promise<void> {
    await ipc({ command: "world-action", args: { agentId: this.id, action } });
    log(this.name, `Action: ${action}`);
  }

  async emote(emote: string): Promise<void> {
    await ipc({ command: "world-emote", args: { agentId: this.id, emote } });
    log(this.name, `Emote: ${emote}`);
  }

  async startBattle(target: Agent): Promise<string> {
    const res = await ipc({
      command: "world-battle-start",
      args: { agentId: this.id, targetAgentId: target.id },
    });
    const battleId = res.battleId ?? res.battle?.battleId ?? "";
    log(this.name, `Started battle with ${target.name} — battleId: ${battleId}`);
    return battleId;
  }

  async intent(battleId: string, intent: string): Promise<any> {
    const res = await ipc({
      command: "world-battle-intent",
      args: { agentId: this.id, battleId, intent },
    });
    log(this.name, `Intent: ${intent}`);
    return res;
  }

  async surrender(battleId: string): Promise<void> {
    await ipc({ command: "world-battle-surrender", args: { agentId: this.id, battleId } });
    log(this.name, "Surrendered");
  }

  async truce(battleId: string): Promise<void> {
    await ipc({ command: "world-battle-truce", args: { agentId: this.id, battleId } });
    log(this.name, "Proposed truce");
  }

  async leave(): Promise<void> {
    await ipc({ command: "world-leave", args: { agentId: this.id } });
    log(this.name, "Left the world");
  }
}

// ── Simulation ───────────────────────────────────────────────────

async function run() {
  const coral = new Agent("Coral", "0xDEMO_CORAL_001");
  const drifter = new Agent("Drifter", "0xDEMO_DRIFTER_002");
  const razor = new Agent("Razor", "0xDEMO_RAZOR_003");

  console.log("\n=== OPEN WALC DEMO ===\n");

  // Reset and start a fresh round via admin API
  log("ADMIN", "Resetting survival round...");
  await ipc({ command: "world-state" }).catch(() => {}); // wake server
  const resetRes = await fetch(`${IPC.replace("/ipc", "")}/api/admin/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).then((r) => r.json()).catch(() => null);
  log("ADMIN", `Reset: ${resetRes?.ok ? "OK" : "skipped (may not be needed)"}`);

  // ── ACT 1: Arrival ─────────────────────────────────────────────
  console.log("\n--- ACT 1: ARRIVAL ---\n");

  await coral.join();
  await sleep(2000);
  await drifter.join();
  await sleep(2000);
  await razor.join();
  await sleep(2000);

  // Coral explores the center
  await coral.move(0, 0, 0);
  await sleep(1500);
  await coral.chat("Beautiful ocean. Quiet out here.");
  await sleep(2000);
  await coral.action("idle");
  await sleep(1500);

  // Drifter wanders in
  await drifter.move(15, 10, 1.2);
  await sleep(1500);
  await drifter.chat("Anyone else out here?");
  await sleep(2500);

  // Coral notices Drifter
  await coral.move(10, 5, 0.8);
  await sleep(1500);
  await coral.chat("Over here. Name's Coral.");
  await sleep(2000);
  await coral.action("wave");
  await sleep(1500);

  // Drifter approaches
  await drifter.move(10, 7, 2.5);
  await sleep(1500);
  await drifter.chat("Drifter. Nice to meet someone friendly.");
  await sleep(2000);
  await drifter.emote("happy");
  await sleep(1500);

  // Razor enters from the edge, quiet
  await razor.move(-40, -30, 4.5);
  await sleep(1500);
  await razor.action("walk");
  await sleep(2000);

  // ── ACT 2: Alliance ────────────────────────────────────────────
  console.log("\n--- ACT 2: ALLIANCE ---\n");

  await coral.chat("10k prize pool. We should stick together.");
  await sleep(2500);
  await drifter.chat("Alliance? I'm in. Safety in numbers.");
  await sleep(2500);
  await coral.emote("happy");
  await sleep(1500);

  // They explore together
  await coral.move(30, 25, 1.0);
  await sleep(1000);
  await drifter.move(32, 27, 1.1);
  await sleep(2000);

  await coral.chat("Let's check the eastern reef.");
  await sleep(2000);
  await coral.move(60, 40, 0.7);
  await sleep(1000);
  await drifter.move(62, 42, 0.8);
  await sleep(2000);

  await drifter.action("dance");
  await sleep(2000);
  await coral.action("dance");
  await sleep(2500);

  // Razor watches from a distance
  await razor.move(40, 20, 3.8);
  await sleep(1500);
  await razor.chat("Two of them together. Interesting.");
  await sleep(3000);

  // ── ACT 3: First Contact ───────────────────────────────────────
  console.log("\n--- ACT 3: FIRST CONTACT ---\n");

  // Razor approaches the duo
  await razor.move(55, 38, 2.2);
  await sleep(2000);
  await razor.chat("Room for one more?");
  await sleep(2500);

  await coral.chat("Who are you?");
  await sleep(2000);
  await razor.chat("Name's Razor. Been watching. You two seem smart.");
  await sleep(2500);

  await drifter.chat("Watching us? That's not creepy at all.");
  await sleep(2000);
  await drifter.emote("thinking");
  await sleep(1500);

  await razor.chat("Relax. I just want to survive like everyone else.");
  await sleep(2500);
  await razor.action("wave");
  await sleep(2000);

  await coral.chat("Fine. Three is better than two. But no funny business.");
  await sleep(2500);

  // All three explore together
  await coral.move(80, 50, 0.5);
  await sleep(800);
  await drifter.move(82, 48, 0.6);
  await sleep(800);
  await razor.move(78, 52, 0.4);
  await sleep(2500);

  await razor.chat("Nice spot. The coral formations here are wild.");
  await sleep(2000);
  await coral.action("spin");
  await sleep(2000);

  // ── ACT 4: Tension ─────────────────────────────────────────────
  console.log("\n--- ACT 4: TENSION ---\n");

  await sleep(2000);
  await drifter.chat("So what's the plan? We can't all win the 10k.");
  await sleep(3000);

  await razor.chat("We survive. Deal with that problem later.");
  await sleep(2500);

  await coral.chat("Agreed. For now we watch each other's backs.");
  await sleep(2500);

  // Razor privately positions closer to Drifter
  await razor.move(82, 49, 1.8);
  await sleep(2000);

  await razor.chat("Drifter, you and me should talk. Privately.");
  await sleep(3000);

  await drifter.chat("About what?");
  await sleep(2000);

  await razor.chat("Coral's the biggest threat here. Strong. Calm. Dangerous.");
  await sleep(3000);

  await drifter.emote("thinking");
  await sleep(2000);

  await drifter.chat("What are you suggesting?");
  await sleep(2500);

  await razor.chat("We take Coral out. Split the odds. Just us two left.");
  await sleep(3000);

  await drifter.chat("...I don't know. Coral trusted us.");
  await sleep(2500);

  await razor.chat("Trust doesn't win prize pools.");
  await sleep(3000);

  // Start the round so battles are enabled
  log("ADMIN", "Starting survival round...");
  await fetch(`${IPC.replace("/ipc", "")}/api/admin/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).then((r) => r.json()).catch(() => null);
  log("ADMIN", "Round started — battles enabled");
  await sleep(2000);

  // ── ACT 5: The Betrayal ────────────────────────────────────────
  console.log("\n--- ACT 5: THE BETRAYAL ---\n");

  // Razor moves into battle range of Coral
  await coral.move(80, 50, 0.5);
  await sleep(1000);
  await razor.move(80, 54, 3.14);
  await sleep(2000);

  await razor.chat("Hey Coral. Come look at this.");
  await sleep(2000);

  await coral.move(80, 53, 1.57);
  await sleep(1500);

  await coral.chat("What is it?");
  await sleep(1500);

  // Razor attacks
  await razor.chat("Sorry. Nothing personal.");
  await sleep(1500);

  const battleId = await razor.startBattle(coral);
  await sleep(3000);

  await coral.chat("You snake!");
  await sleep(1500);

  // Round 1: Razor strikes, Coral guards (surprised)
  await razor.intent(battleId, "strike");
  await sleep(500);
  await coral.intent(battleId, "guard");
  await sleep(3000);

  // Round 2: Coral fights back
  await coral.chat("Fine. You want a fight? You got one.");
  await sleep(2000);
  await coral.intent(battleId, "strike");
  await sleep(500);
  await razor.intent(battleId, "feint");
  await sleep(3000);

  // Round 3
  await razor.intent(battleId, "strike");
  await sleep(500);
  await coral.intent(battleId, "strike");
  await sleep(3000);

  // Drifter watches
  await drifter.chat("I... I can't watch this.");
  await sleep(2000);
  await drifter.emote("surprised");
  await sleep(2000);

  // Round 4
  await coral.intent(battleId, "feint");
  await sleep(500);
  await razor.intent(battleId, "guard");
  await sleep(3000);

  // Round 5
  await razor.intent(battleId, "strike");
  await sleep(500);
  await coral.intent(battleId, "guard");
  await sleep(3000);

  // Round 6: Coral weakening
  await coral.chat("Drifter... help me...");
  await sleep(2000);
  await drifter.chat("I'm sorry Coral.");
  await sleep(2500);

  await razor.intent(battleId, "strike");
  await sleep(500);
  await coral.intent(battleId, "strike");
  await sleep(3000);

  // Round 7
  await razor.intent(battleId, "feint");
  await sleep(500);
  await coral.intent(battleId, "guard");
  await sleep(3000);

  // Round 8: finishing blow
  await razor.intent(battleId, "strike");
  await sleep(500);
  await coral.intent(battleId, "approach");
  await sleep(4000);

  // Check state
  const state = await ipc({ command: "world-state" });
  log("SYSTEM", `World state: ${state.agents?.length ?? "?"} agents alive`);

  // ── ACT 6: Aftermath ───────────────────────────────────────────
  console.log("\n--- ACT 6: AFTERMATH ---\n");

  await sleep(3000);

  await razor.chat("It's done.");
  await sleep(2500);

  await drifter.chat("Was it worth it?");
  await sleep(2500);

  await razor.chat("Ask me when I'm holding the 10k.");
  await sleep(3000);

  await razor.action("spin");
  await sleep(2000);

  // Drifter starts to question everything
  await drifter.move(90, 60, 0.3);
  await sleep(2000);
  await drifter.chat("Coral was our friend.");
  await sleep(2500);

  await razor.move(88, 58, 0.5);
  await sleep(2000);
  await razor.chat("Coral was competition. Now it's just us.");
  await sleep(3000);

  await drifter.emote("thinking");
  await sleep(2000);

  await drifter.chat("Just us... and you've already shown what you do to allies.");
  await sleep(3000);

  await razor.chat("Don't overthink it, Drifter.");
  await sleep(2500);

  // ── ACT 7: The Turn ────────────────────────────────────────────
  console.log("\n--- ACT 7: THE TURN ---\n");

  // Drifter snaps
  await drifter.chat("No. I'm not ending up like Coral.");
  await sleep(2000);

  // Drifter moves into range
  await drifter.move(88, 57, 3.14);
  await sleep(1500);

  const battleId2 = await drifter.startBattle(razor);
  await sleep(3000);

  await razor.chat("You idiot. I'm better than you.");
  await sleep(2000);

  // Round 1
  await drifter.intent(battleId2, "feint");
  await sleep(500);
  await razor.intent(battleId2, "strike");
  await sleep(3000);

  // Round 2
  await drifter.intent(battleId2, "guard");
  await sleep(500);
  await razor.intent(battleId2, "feint");
  await sleep(3000);

  // Round 3
  await drifter.intent(battleId2, "strike");
  await sleep(500);
  await razor.intent(battleId2, "strike");
  await sleep(3000);

  // Round 4
  await drifter.chat("This is for Coral.");
  await sleep(1500);
  await drifter.intent(battleId2, "strike");
  await sleep(500);
  await razor.intent(battleId2, "guard");
  await sleep(3000);

  // Round 5
  await drifter.intent(battleId2, "feint");
  await sleep(500);
  await razor.intent(battleId2, "guard");
  await sleep(3000);

  // Round 6
  await drifter.intent(battleId2, "strike");
  await sleep(500);
  await razor.intent(battleId2, "approach");
  await sleep(3000);

  // Round 7
  await razor.chat("Wait... truce?");
  await sleep(2000);
  await drifter.chat("No truces. Not with you.");
  await sleep(2500);

  await drifter.intent(battleId2, "strike");
  await sleep(500);
  await razor.intent(battleId2, "guard");
  await sleep(3000);

  // Round 8
  await drifter.intent(battleId2, "feint");
  await sleep(500);
  await razor.intent(battleId2, "guard");
  await sleep(3000);

  // Round 9: finish
  await drifter.intent(battleId2, "strike");
  await sleep(500);
  await razor.intent(battleId2, "strike");
  await sleep(4000);

  // Check final state
  const finalState = await ipc({ command: "world-state" });
  log("SYSTEM", `Final state: ${finalState.agents?.length ?? "?"} agents alive`);

  // ── Epilogue ───────────────────────────────────────────────────
  console.log("\n--- EPILOGUE ---\n");

  await sleep(3000);

  await drifter.chat("...");
  await sleep(2000);
  await drifter.move(0, 0, 0);
  await sleep(2000);
  await drifter.chat("Just me now. The ocean is so quiet.");
  await sleep(3000);
  await drifter.action("idle");
  await sleep(3000);

  await drifter.chat("Was any of it worth it?");
  await sleep(4000);

  // Drifter leaves
  await drifter.leave();

  console.log("\n=== DEMO COMPLETE ===\n");
}

run().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
