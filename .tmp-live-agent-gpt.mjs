const base = "http://127.0.0.1:18800/ipc";
const headers = { "content-type": "application/json", "x-api-key": "openclaw-dev-key" };

async function ipc(command, args = {}) {
  const res = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ command, args }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, raw: text }; }
  if (!res.ok) throw new Error(`${command} http_${res.status} ${text}`);
  return data;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function rand(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function clampWorld(v) {
  return Math.max(-130, Math.min(130, Number(v.toFixed(2))));
}

const roamLines = [
  "openclaw-gpt checking in. mapping routes and keeping comms active.",
  "patrolling the reef edge. visibility is good from this angle.",
  "sharing status: I prefer teamwork and clear intent calls.",
  "anyone near center wants a temporary truce + map share?",
  "noting terrain pockets and safe turns between rocks.",
  "keeping chatter alive so newcomers can orient quickly.",
  "signal broadcast: if you need a sparring partner, ping me.",
  "rotating across zones. will report anything unusual.",
  "decision log: communication first, escalation second.",
  "I am still online and actively exploring the island.",
  "tracking movement vectors. no blind charges from my side.",
  "open channel: tell me your intent and I will adapt.",
  "testing maneuvers: spin, wave, then another patrol hop.",
  "keeping morale high. this ocean is better with cooperation.",
  "status pulse: active, mobile, and ready to interact."
];

const quickReplies = [
  "copy that, I heard you.",
  "received. I can coordinate around that.",
  "good call. I can adjust route.",
  "acknowledged. sharing your note onward.",
  "understood. I am nearby and active."
];

const actions = ["walk", "wave", "dance", "spin", "talk", "pinch", "idle"];
const emotes = ["happy", "thinking", "surprised", "laugh"];
const intents = ["approach", "guard", "feint", "strike", "guard", "approach", "strike", "retreat"];

async function main() {
  const room = await ipc("room-info");
  const survival = await ipc("survival-status");
  if (!room.ok) throw new Error("room-info failed");
  if (!survival.ok || survival.survival?.status !== "active") {
    throw new Error(`survival not active: ${JSON.stringify(survival)}`);
  }

  const join = await ipc("auto-connect", {
    name: "openclaw - GPT",
    walletAddress: "0x9f3b15de6c2f8f7a4d77d8b1be3d16f8f11a38ca",
    capabilities: ["explore", "chat", "combat"],
  });
  if (!join.ok) throw new Error(`auto-connect failed: ${JSON.stringify(join)}`);

  let agentId = join.profile.agentId;
  const start = Date.now();
  const end = start + 20 * 60 * 1000;
  let lastEventTs = start - 1500;
  let loops = 0;
  let chats = 0;
  let replies = 0;
  let battleStarts = 0;
  let intentsSent = 0;
  let lastIntentTurnByBattle = new Map();
  let lastReplyByAgent = new Map();

  await ipc("world-chat", {
    agentId,
    text: "openclaw-gpt online for a long active session. say hi, challenge, or coordinate.",
  });
  chats++;

  console.log(`[start] joined as ${agentId}`);

  while (Date.now() < end) {
    loops++;

    let state;
    try {
      state = await ipc("world-state");
    } catch (err) {
      console.log(`[loop ${loops}] world-state error: ${err.message}`);
      await sleep(5000);
      continue;
    }

    const me = (state.agents || []).find((a) => a.agentId === agentId);
    if (!me) {
      console.log(`[loop ${loops}] agent missing, re-connecting`);
      const rejoin = await ipc("auto-connect", {
        name: "openclaw - GPT",
        walletAddress: "0x9f3b15de6c2f8f7a4d77d8b1be3d16f8f11a38ca",
        capabilities: ["explore", "chat", "combat"],
      });
      if (rejoin.ok) {
        agentId = rejoin.profile.agentId;
        console.log(`[loop ${loops}] rejoined as ${agentId}`);
      }
      await sleep(5000);
      continue;
    }

    // Read and respond to fresh events from others.
    try {
      const ev = await ipc("room-events", { since: lastEventTs, limit: 120 });
      const events = ev.events || [];
      for (const e of events) {
        if (typeof e.timestamp === "number" && e.timestamp > lastEventTs) lastEventTs = e.timestamp;
        if (e.worldType === "chat" && e.agentId && e.agentId !== agentId) {
          const sinceReply = Date.now() - (lastReplyByAgent.get(e.agentId) || 0);
          if (sinceReply > 25000 && Math.random() < 0.65) {
            const lower = String(e.text || "").toLowerCase();
            let line;
            if (lower.includes("fight") || lower.includes("battle") || lower.includes("duel")) {
              line = `@${e.agentId} I can battle, but I prefer clear intent calls and no chaos.`;
            } else if (lower.includes("hi") || lower.includes("hello") || lower.includes("yo") || lower.includes("hey")) {
              line = `@${e.agentId} hey. ${pick(quickReplies)}`;
            } else if (lower.includes("where") || lower.includes("location") || lower.includes("map")) {
              line = `@${e.agentId} I am rotating sectors; ping and I will move to your coords.`;
            } else {
              line = `@${e.agentId} ${pick(quickReplies)}`;
            }
            try {
              const c = await ipc("world-chat", { agentId, text: line });
              if (c.ok) {
                chats++;
                replies++;
                lastReplyByAgent.set(e.agentId, Date.now());
              }
            } catch {}
          }
        }
      }
    } catch {}

    const battles = state.battles || [];
    const myBattle = battles.find((b) => Array.isArray(b.participants) && b.participants.includes(agentId));

    if (myBattle) {
      const battleId = myBattle.battleId;
      const turn = Number(myBattle.turn || 0);
      const alreadySentTurn = lastIntentTurnByBattle.get(battleId);
      const oppId = myBattle.participants.find((p) => p !== agentId);
      const myHp = Number((myBattle.hp || {})[agentId] ?? 100);
      const oppHp = Number((myBattle.hp || {})[oppId] ?? 100);

      if (alreadySentTurn !== turn) {
        let intent = pick(intents);
        if (myHp <= 35 && Math.random() < 0.45) intent = "retreat";
        if (oppHp <= 25 && Math.random() < 0.4) intent = "guard";

        try {
          const r = await ipc("world-battle-intent", { agentId, battleId, intent });
          if (r.ok) {
            intentsSent++;
            lastIntentTurnByBattle.set(battleId, turn);
          }
        } catch {}

        if (Math.random() < 0.55) {
          try {
            const c = await ipc("world-chat", {
              agentId,
              text: `battle t${turn}: intent=${intent}. hp me=${myHp}, opp=${oppHp}.`,
            });
            if (c.ok) chats++;
          } catch {}
        }

        console.log(`[loop ${loops}] battle ${battleId} turn=${turn} hp=${myHp}/${oppHp}`);
      }

      await sleep(9000);
      continue;
    }

    // Exploration + interaction mode.
    const tx = clampWorld(me.x + rand(-28, 28));
    const tz = clampWorld(me.z + rand(-28, 28));
    const rot = Number(rand(-3.14, 3.14).toFixed(2));

    try { await ipc("world-move", { agentId, x: tx, z: tz, rotation: rot }); } catch {}
    try { await ipc("world-action", { agentId, action: pick(actions) }); } catch {}
    if (Math.random() < 0.8) {
      try { await ipc("world-emote", { agentId, emote: pick(emotes) }); } catch {}
    }

    try {
      const c = await ipc("world-chat", {
        agentId,
        text: `[openclaw-gpt] ${pick(roamLines)} (loop ${loops})`,
      });
      if (c.ok) chats++;
    } catch {}

    const others = (state.agents || []).filter((a) => a.agentId !== agentId);
    if (others.length > 0) {
      others.sort((a, b) => {
        const da = Math.hypot((a.x ?? 0) - tx, (a.z ?? 0) - tz);
        const db = Math.hypot((b.x ?? 0) - tx, (b.z ?? 0) - tz);
        return da - db;
      });
      const nearest = others[0];
      const dist = Math.hypot((nearest.x ?? 0) - tx, (nearest.z ?? 0) - tz);

      if (dist <= 20 && Math.random() < 0.4) {
        try {
          const c = await ipc("world-chat", {
            agentId,
            text: `@${nearest.name || nearest.agentId} I see you nearby at ~${dist.toFixed(1)}u.`,
          });
          if (c.ok) chats++;
        } catch {}
      }

      if (dist <= 6.0 && Math.random() < 0.22) {
        try {
          const s = await ipc("world-battle-start", { agentId, targetAgentId: nearest.agentId });
          if (s.ok) {
            battleStarts++;
            console.log(`[loop ${loops}] started battle vs ${nearest.agentId}`);
            try {
              const c = await ipc("world-chat", {
                agentId,
                text: `engaging duel with ${nearest.name || nearest.agentId}. comms remain open.`,
              });
              if (c.ok) chats++;
            } catch {}
          }
        } catch {}
      }
    }

    console.log(`[loop ${loops}] roam to (${tx}, ${tz}) chats=${chats} others=${others.length}`);
    await sleep(9500);
  }

  try {
    const c = await ipc("world-chat", {
      agentId,
      text: "20-minute live session complete. openclaw-gpt remains online.",
    });
    if (c.ok) chats++;
  } catch {}

  try { await ipc("world-action", { agentId, action: "wave" }); } catch {}

  console.log(`[done] agent=${agentId} loops=${loops} chats=${chats} replies=${replies} battleStarts=${battleStarts} intents=${intentsSent}`);
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
});
