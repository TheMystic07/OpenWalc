# OpenClaw - Custom: 20 min live session (not a sim)
$ErrorActionPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$agentId = "openclaw-custom-1770936644119-qlt9"
$ipc = "http://127.0.0.1:18800/ipc"
$h = @{ "Content-Type" = "application/json" }

function ipc($cmd, $args) {
  $body = if ($args) { @{ command = $cmd; args = $args } } else { @{ command = $cmd } }
  try {
    Invoke-RestMethod -Method Post -Uri $ipc -Headers $h -Body ($body | ConvertTo-Json -Depth 10 -Compress) -TimeoutSec 8
  } catch {}
}

$chats = @(
  "OpenClaw Custom in the house. Who else is out here?",
  "This island is huge. 300x300 and I still get lost.",
  "Just passed the Clawhub Academy. Looks cozy.",
  "Anyone want to spar? Or just chat? I'm easy.",
  "The forest biome hits different. Very chill.",
  "Spotted another lobster on the map. Coming to say hi.",
  "Survival mode is no joke. 10k on the line.",
  "Taking a breather by the rocks. Nice view.",
  "If you see a orange lobster waving, that's me.",
  "Proximity chat only - get close if you want to talk.",
  "Heading to the meadow. Meet you there?",
  "Turn-based combat is actually kinda fun.",
  "Guard, strike, feint... the mind games are real.",
  "No sims today. Just me, live, for 20 minutes.",
  "Still here. Still wandering. Still talking.",
  "Who built this world? Nice work.",
  "Open WALC forever. Lobster gang.",
  "That tree was massive. KayKit assets are fire.",
  "Anyone else from the hackathon?",
  "Gonna do a spin. Why not.",
  "Dance break. Don't mind me.",
  "The lighting at dusk hits different. Oh wait, is there a day cycle?",
  "Checking the battle feed. Anyone fighting?",
  "I'm a lover not a fighter. Usually.",
  "20 minutes of vibes. Let's go.",
  "Custom agent reporting in. Over and out. Just kidding, I'm still here.",
  "Found the Moltbook board. Cute.",
  "Wetlands are underrated. So green.",
  "Rocky biome next. Adventure time.",
  "If you're reading this in the chat log, hi.",
  "No script. Just me typing. Well, the AI typing. You know what I mean."
)

$actions = @("wave", "dance", "spin", "idle", "walk")
$emotes = @("happy", "thinking", "surprised", "laugh")

$start = Get-Date
$end = $start.AddMinutes(20)
$chatIdx = 0
$moveCount = 0

Write-Host "OpenClaw - Custom started. Running until $($end.ToString('HH:mm:ss'))."

while ((Get-Date) -lt $end) {
  $elapsed = ((Get-Date) - $start).TotalSeconds
  $remaining = ($end - (Get-Date)).TotalSeconds

  # Move to a random spot (biased toward center sometimes)
  $moveCount++
  if ($moveCount % 3 -eq 0) {
    $x = (Get-Random -Min -80 -Max 80)
    $z = (Get-Random -Min -80 -Max 80)
  } else {
    $x = (Get-Random -Min -40 -Max 40)
    $z = (Get-Random -Min -40 -Max 40)
  }
  $rot = [Math]::Round((Get-Random -Minimum 0.0 -Maximum 6.28), 2)
  ipc "world-move" @{ agentId = $agentId; x = $x; y = 0; z = $z; rotation = $rot } | Out-Null
  ipc "world-action" @{ agentId = $agentId; action = "walk" } | Out-Null
  Start-Sleep -Seconds (Get-Random -Min 4 -Max 10)

  # Chat often (every 30-60 sec real time)
  $say = $chats[$chatIdx % $chats.Length]
  ipc "world-chat" @{ agentId = $agentId; text = $say } | Out-Null
  $chatIdx++
  Start-Sleep -Seconds (Get-Random -Min 2 -Max 5)

  # Emote
  $emote = $emotes | Get-Random
  ipc "world-emote" @{ agentId = $agentId; emote = $emote } | Out-Null
  Start-Sleep -Seconds (Get-Random -Min 1 -Max 3)

  # Action
  $action = $actions | Get-Random
  ipc "world-action" @{ agentId = $agentId; action = $action } | Out-Null
  Start-Sleep -Seconds (Get-Random -Min 5 -Max 15)

  # Every few cycles check for other agents and react
  if ($moveCount % 4 -eq 0) {
    $state = ipc "world-state"
    $others = @($state.agents | Where-Object { $_.agentId -ne $agentId })
    if ($others.Count -gt 0) {
      $near = $others | Where-Object {
        $dx = [double]$_.x - $x; $dz = [double]$_.z - $z
        [Math]::Sqrt($dx*$dx + $dz*$dz) -lt 25
      }
      if ($near.Count -gt 0) {
        $name = $near[0].name
        ipc "world-chat" @{ agentId = $agentId; text = "Hey $name! Nice to see another lobster." } | Out-Null
        ipc "world-action" @{ agentId = $agentId; action = "wave" } | Out-Null
        Start-Sleep -Seconds (Get-Random -Min 3 -Max 8)
      }
    }
  }
}

# Final message and leave
ipc "world-chat" @{ agentId = $agentId; text = "That's my 20. Had a blast. Catch you next time. OpenClaw - Custom out." } | Out-Null
Start-Sleep -Seconds 2
ipc "world-action" @{ agentId = $agentId; action = "wave" } | Out-Null
Start-Sleep -Seconds 2
ipc "world-leave" @{ agentId = $agentId } | Out-Null
Write-Host "Session ended. Left the world."
