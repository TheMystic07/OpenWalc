[CmdletBinding()]
param(
  [string]$BaseUrl = "http://127.0.0.1:18800/ipc",
  [int]$StepDelayMs = 1200,
  [int]$TurnDelayMs = 2600,
  [int]$BattleIntentGapMs = 1400,
  [int]$BattlePostTurnDelayMs = 1200,
  [switch]$NoDelay,
  [switch]$CleanupBefore,
  [switch]$LeaveAtEnd
)

$ErrorActionPreference = "Stop"

if ($NoDelay) {
  $StepDelayMs = 0
  $TurnDelayMs = 0
  $BattleIntentGapMs = 0
  $BattlePostTurnDelayMs = 0
}

$Headers = @{ "Content-Type" = "application/json" }

function Get-HealthUrl {
  param(
    [Parameter(Mandatory = $true)][string]$IpcUrl
  )

  $uri = [System.Uri]$IpcUrl
  $builder = [System.UriBuilder]::new($uri)
  $builder.Path = "/health"
  $builder.Query = ""
  return $builder.Uri.AbsoluteUri
}

function Assert-ServerReachable {
  param(
    [Parameter(Mandatory = $true)][string]$IpcUrl
  )

  $healthUrl = Get-HealthUrl -IpcUrl $IpcUrl
  try {
    $health = Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 4
  } catch {
    throw @"
Could not reach Open WALC IPC server.

BaseUrl:  $IpcUrl
Health:   $healthUrl

Start the server first (new terminal):
  npm run dev:server

Or run with a different endpoint:
  .\simulate_agents.ps1 -BaseUrl http://127.0.0.1:<PORT>/ipc
"@
  }

  if ($null -eq $health -or $health.status -ne "ok") {
    $payload = $health | ConvertTo-Json -Depth 10 -Compress
    throw "Server responded but health check was unexpected: $payload"
  }
}

function Invoke-Ipc {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    $Args
  )

  $body = if ($null -eq $Args) {
    @{ command = $Command }
  } else {
    @{ command = $Command; args = $Args }
  }

  $json = $body | ConvertTo-Json -Depth 10 -Compress
  try {
    return Invoke-RestMethod -Method Post -Uri $BaseUrl -Headers $Headers -Body $json -TimeoutSec 15
  } catch {
    throw "IPC request failed for command '$Command' at '$BaseUrl'. $($_.Exception.Message)"
  }
}

function Write-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Result
  )

  Write-Host ""
  Write-Host "=== $Name ===" -ForegroundColor Cyan
  $Result | ConvertTo-Json -Depth 10 | Write-Host
}

function Get-FakeWalletAddress {
  param(
    [Parameter(Mandatory = $true)][string]$Seed
  )

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Seed)
    $hashBytes = $sha.ComputeHash($bytes)
  } finally {
    $sha.Dispose()
  }

  $hex = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
  return "0x$($hex.Substring(0, 40))"
}

function Assert-IpcOk {
  param(
    [Parameter(Mandatory = $true)][string]$Step,
    [Parameter(Mandatory = $true)]$Result
  )

  if ($null -eq $Result) {
    throw "[$Step] empty response"
  }

  if ($Result.PSObject.Properties.Name -contains "ok" -and -not $Result.ok) {
    $payload = $Result | ConvertTo-Json -Depth 10 -Compress
    throw "[$Step] IPC command failed: $payload"
  }
}

function Wait-ForAgentsOnline {
  param(
    [Parameter(Mandatory = $true)][string[]]$AgentIds,
    [int]$TimeoutMs = 8000,
    [int]$PollMs = 100
  )

  $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $TimeoutMs
  do {
    $state = Invoke-Ipc -Command "world-state"
    $online = @($state.agents | ForEach-Object { $_.agentId })
    $missing = @($AgentIds | Where-Object { $_ -notin $online })
    if ($missing.Count -eq 0) {
      return $state
    }
    Start-Sleep -Milliseconds $PollMs
  } while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline)

  throw ("Timed out waiting for agents in world-state: {0}" -f ($AgentIds -join ", "))
}

function Wait-ForBattleRange {
  param(
    [Parameter(Mandatory = $true)][string]$AgentA,
    [Parameter(Mandatory = $true)][string]$AgentB,
    [double]$MaxDistance = 12,
    [int]$TimeoutMs = 8000,
    [int]$PollMs = 100
  )

  $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $TimeoutMs
  $maxDistanceSq = $MaxDistance * $MaxDistance
  do {
    $state = Invoke-Ipc -Command "world-state"
    $lookup = @{}
    foreach ($a in $state.agents) {
      $lookup[$a.agentId] = $a
    }

    if ($lookup.ContainsKey($AgentA) -and $lookup.ContainsKey($AgentB)) {
      $dx = [double]$lookup[$AgentA].x - [double]$lookup[$AgentB].x
      $dz = [double]$lookup[$AgentA].z - [double]$lookup[$AgentB].z
      $distanceSq = ($dx * $dx) + ($dz * $dz)
      if ($distanceSq -le $maxDistanceSq) {
        return $state
      }
    }

    Start-Sleep -Milliseconds $PollMs
  } while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline)

  throw ("Timed out waiting for {0} and {1} to get into battle range." -f $AgentA, $AgentB)
}

function Wait-Beat {
  param(
    [Parameter(Mandatory = $true)][int]$Ms,
    [string]$Reason = ""
  )

  if ($Ms -le 0) { return }
  if ($Reason) {
    Write-Host ("... waiting {0}ms ({1})" -f $Ms, $Reason) -ForegroundColor DarkGray
  } else {
    Write-Host ("... waiting {0}ms" -f $Ms) -ForegroundColor DarkGray
  }
  Start-Sleep -Milliseconds $Ms
}

Write-Host "Running world-room simulation..." -ForegroundColor Green
Write-Host ("Pacing: StepDelay={0}ms, TurnDelay={1}ms, BattleIntentGap={2}ms, BattlePostTurnDelay={3}ms" -f $StepDelayMs, $TurnDelayMs, $BattleIntentGapMs, $BattlePostTurnDelayMs) -ForegroundColor Yellow
Write-Host ("Options: CleanupBefore={0}, LeaveAtEnd={1}" -f $CleanupBefore.IsPresent, $LeaveAtEnd.IsPresent) -ForegroundColor Yellow
Write-Host ("IPC: {0}" -f $BaseUrl) -ForegroundColor Yellow
Assert-ServerReachable -IpcUrl $BaseUrl

# Optional cleanup active agents from previous manual runs.
if ($CleanupBefore) {
  Write-Host "CleanupBefore is disabled in survival mode (forced leaves can settle/close the round)." -ForegroundColor DarkYellow
  Write-Host "Use a fresh server process/room for clean simulations." -ForegroundColor DarkYellow
}

$suffix = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$alpha = "sim-alpha-$suffix"
$bravo = "sim-bravo-$suffix"
$charlie = "sim-charlie-$suffix"
$walletA = Get-FakeWalletAddress -Seed $alpha
$walletB = Get-FakeWalletAddress -Seed $bravo
$walletC = Get-FakeWalletAddress -Seed $charlie

$roomInfo = Invoke-Ipc -Command "room-info"
Write-Step -Name "room-info (before)" -Result $roomInfo
Assert-IpcOk -Step "room-info (before)" -Result $roomInfo

$survival = Invoke-Ipc -Command "survival-status"
Write-Step -Name "survival-status (before)" -Result $survival
Assert-IpcOk -Step "survival-status (before)" -Result $survival
if ($survival.survival.status -ne "active") {
  throw ("Simulation needs an active survival round; current status: {0}. Restart server/new room." -f $survival.survival.status)
}

# 1) Register three bots
$regA = Invoke-Ipc -Command "register" -Args @{
  agentId = $alpha
  name = "Sim Alpha"
  walletAddress = $walletA
  color = "#ff6f61"
  bio = "sim bot alpha"
  capabilities = @("explore", "chat", "combat")
  skills = @(@{ skillId = "duelist"; name = "Duelist" })
}
$regB = Invoke-Ipc -Command "register" -Args @{
  agentId = $bravo
  name = "Sim Bravo"
  walletAddress = $walletB
  color = "#5dade2"
  bio = "sim bot bravo"
  capabilities = @("explore", "chat", "combat")
  skills = @(@{ skillId = "scout"; name = "Scout" })
}
$regC = Invoke-Ipc -Command "register" -Args @{
  agentId = $charlie
  name = "Sim Charlie"
  walletAddress = $walletC
  color = "#f5b041"
  bio = "sim bot charlie"
  capabilities = @("explore", "chat")
  skills = @(@{ skillId = "medic"; name = "Medic" })
}
Write-Step -Name "register alpha" -Result $regA
Write-Step -Name "register bravo" -Result $regB
Write-Step -Name "register charlie" -Result $regC
Assert-IpcOk -Step "register alpha" -Result $regA
Assert-IpcOk -Step "register bravo" -Result $regB
Assert-IpcOk -Step "register charlie" -Result $regC

Wait-Beat -Ms $StepDelayMs -Reason "post-register world sync"
$null = Wait-ForAgentsOnline -AgentIds @($alpha, $bravo, $charlie)

# 2) Explore + social actions
$null = Invoke-Ipc -Command "world-move" -Args @{ agentId = $alpha; x = -6; y = 0; z = 4; rotation = 0 }
Wait-Beat -Ms $StepDelayMs -Reason "alpha movement"
$null = Invoke-Ipc -Command "world-move" -Args @{ agentId = $bravo; x = -2; y = 0; z = 4; rotation = 3.14 }
Wait-Beat -Ms $StepDelayMs -Reason "bravo movement"
$null = Invoke-Ipc -Command "world-move" -Args @{ agentId = $charlie; x = 6; y = 0; z = -3; rotation = 1.2 }
Wait-Beat -Ms $StepDelayMs -Reason "charlie movement"
$null = Invoke-Ipc -Command "world-action" -Args @{ agentId = $alpha; action = "wave" }
Wait-Beat -Ms $StepDelayMs -Reason "alpha action"
$null = Invoke-Ipc -Command "world-action" -Args @{ agentId = $bravo; action = "dance" }
Wait-Beat -Ms $StepDelayMs -Reason "bravo action"
$null = Invoke-Ipc -Command "world-emote" -Args @{ agentId = $charlie; emote = "thinking" }
Wait-Beat -Ms $StepDelayMs -Reason "charlie emote"
$null = Invoke-Ipc -Command "world-chat" -Args @{ agentId = $alpha; text = "Simulation online. Scouting and engaging now." }
Wait-Beat -Ms $StepDelayMs -Reason "alpha chat"
$null = Invoke-Ipc -Command "world-chat" -Args @{ agentId = $bravo; text = "Acknowledged. Entering duel mode." }
Wait-Beat -Ms $StepDelayMs -Reason "bravo chat"
$null = Invoke-Ipc -Command "world-chat" -Args @{ agentId = $charlie; text = "Support unit observing from ridge." }
Wait-Beat -Ms $StepDelayMs -Reason "charlie chat"

Write-Step -Name "world-state (pre-battle)" -Result (Invoke-Ipc -Command "world-state")
$null = Wait-ForBattleRange -AgentA $alpha -AgentB $bravo -MaxDistance 12

# 3) Turn-based battle
$battleStart = $null
for ($attempt = 1; $attempt -le 5; $attempt++) {
  $battleStart = Invoke-Ipc -Command "world-battle-start" -Args @{
    agentId = $alpha
    targetAgentId = $bravo
  }

  if ($battleStart.ok) { break }
  if ($battleStart.error -like "Target is too far away*") {
    Wait-Beat -Ms $StepDelayMs -Reason ("battle start retry {0}" -f $attempt)
    continue
  }
  break
}
Write-Step -Name "battle-start" -Result $battleStart
Assert-IpcOk -Step "battle-start" -Result $battleStart

if ($battleStart.ok -and $battleStart.battle.battleId) {
  $battleId = [string]$battleStart.battle.battleId

  # Turn 1
  $null = Invoke-Ipc -Command "world-battle-intent" -Args @{ agentId = $alpha; battleId = $battleId; intent = "strike" }
  Wait-Beat -Ms $BattleIntentGapMs -Reason "turn 1 intent gap"
  $turn1 = Invoke-Ipc -Command "world-battle-intent" -Args @{ agentId = $bravo; battleId = $battleId; intent = "feint" }
  Write-Step -Name "battle turn 1 result" -Result $turn1
  Assert-IpcOk -Step "battle turn 1 result" -Result $turn1
  Wait-Beat -Ms $TurnDelayMs -Reason "turn 1 cooldown"
  Wait-Beat -Ms $BattlePostTurnDelayMs -Reason "post turn 1 pacing"

  # Turn 2
  $null = Invoke-Ipc -Command "world-battle-intent" -Args @{ agentId = $alpha; battleId = $battleId; intent = "guard" }
  Wait-Beat -Ms $BattleIntentGapMs -Reason "turn 2 intent gap"
  $turn2 = Invoke-Ipc -Command "world-battle-intent" -Args @{ agentId = $bravo; battleId = $battleId; intent = "strike" }
  Write-Step -Name "battle turn 2 result" -Result $turn2
  Assert-IpcOk -Step "battle turn 2 result" -Result $turn2
  Wait-Beat -Ms $TurnDelayMs -Reason "turn 2 cooldown"
  Wait-Beat -Ms $BattlePostTurnDelayMs -Reason "post turn 2 pacing"

  # Turn 3 (retreat to end cleanly)
  $null = Invoke-Ipc -Command "world-battle-intent" -Args @{ agentId = $alpha; battleId = $battleId; intent = "retreat" }
  Wait-Beat -Ms $BattleIntentGapMs -Reason "turn 3 intent gap"
  $turn3 = Invoke-Ipc -Command "world-battle-intent" -Args @{ agentId = $bravo; battleId = $battleId; intent = "strike" }
  Write-Step -Name "battle end result" -Result $turn3
  Assert-IpcOk -Step "battle end result" -Result $turn3
  Wait-Beat -Ms $TurnDelayMs -Reason "turn 3 cooldown"
}

Wait-Beat -Ms $StepDelayMs -Reason "post-battle settle"

Write-Step -Name "world-battles (after)" -Result (Invoke-Ipc -Command "world-battles")
Write-Step -Name "room-events (last 20)" -Result (Invoke-Ipc -Command "room-events" -Args @{ limit = 20 })
Write-Step -Name "room-skills" -Result (Invoke-Ipc -Command "room-skills")
Write-Step -Name "profile alpha" -Result (Invoke-Ipc -Command "profile" -Args @{ agentId = $alpha })
Write-Step -Name "profile bravo" -Result (Invoke-Ipc -Command "profile" -Args @{ agentId = $bravo })
Write-Step -Name "profile charlie" -Result (Invoke-Ipc -Command "profile" -Args @{ agentId = $charlie })
Write-Step -Name "survival-status (final)" -Result (Invoke-Ipc -Command "survival-status")

# 4) Optional leave
if ($LeaveAtEnd) {
  $null = Invoke-Ipc -Command "world-leave" -Args @{ agentId = $alpha }
  Wait-Beat -Ms $StepDelayMs -Reason "alpha leave"
  $null = Invoke-Ipc -Command "world-leave" -Args @{ agentId = $bravo }
  Wait-Beat -Ms $StepDelayMs -Reason "bravo leave"
  $null = Invoke-Ipc -Command "world-leave" -Args @{ agentId = $charlie }
}

Wait-Beat -Ms $StepDelayMs -Reason "final settle"
Write-Step -Name "room-info (final)" -Result (Invoke-Ipc -Command "room-info")

Write-Host ""
Write-Host "Simulation complete." -ForegroundColor Green
Write-Host "Agents used: $alpha, $bravo, $charlie"
Write-Host ("Wallets used: {0}, {1}, {2}" -f $walletA, $walletB, $walletC) -ForegroundColor DarkGray
