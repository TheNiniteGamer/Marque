<#
  Marquee control script for Windows + Docker Desktop. The .bat files call this.

    marquee.ps1 Start          build (if needed), start, open the browser
    marquee.ps1 Stop           stop the server (your data is kept)
    marquee.ps1 Update         download the latest version, rebuild and restart
    marquee.ps1 Logs           follow the server log
    marquee.ps1 Watch          update helper: lets the web page's "Update now" button work
    marquee.ps1 InstallHelper  run the helper automatically when you sign in to Windows
    marquee.ps1 RemoveHelper   stop and remove the helper

  Works with Windows PowerShell 5.1 (built into Windows 10/11) and PowerShell 7.
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('Start', 'Stop', 'Update', 'Logs', 'Watch', 'InstallHelper', 'RemoveHelper')]
  [string]$Command = 'Start',
  [switch]$NoPrompt,   # never ask questions or open windows (used by the helper and tests)
  [switch]$Once        # Watch: check one time and exit (used by tests)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Root = $PSScriptRoot
Set-Location -LiteralPath $Root
$ControlDir = Join-Path $Root 'control'
$StatusFile = Join-Path $ControlDir 'status.json'
$RequestFile = Join-Path $ControlDir 'update-request.json'
$CommitFile = Join-Path $Root '.marquee-commit'
$TaskName = 'Marquee Updater'
$OnWindows = $env:OS -eq 'Windows_NT'
New-Item -ItemType Directory -Force -Path $ControlDir | Out-Null

# ---------------------------------------------------------------- settings from .env
function Read-DotEnv {
  $vals = @{}
  $file = Join-Path $Root '.env'
  if (Test-Path -LiteralPath $file) {
    foreach ($line in Get-Content -LiteralPath $file) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $vals[$Matches[1]] = $Matches[2].Trim() }
    }
  }
  return $vals
}
$DotEnv = Read-DotEnv
function Get-Setting([string]$name, [string]$default) { if ($DotEnv[$name]) { return $DotEnv[$name] } return $default }
$Repo = Get-Setting 'MARQUEE_REPO' 'TheNiniteGamer/Marque'
$Branch = Get-Setting 'MARQUEE_BRANCH' 'main'
$Port = Get-Setting 'MARQUEE_PORT' '32500'

# ---------------------------------------------------------------- status shared with the web page
$script:Log = New-Object System.Collections.ArrayList
function Write-Utf8([string]$path, [string]$text) {
  $tmp = "$path.tmp"
  [IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination $path -Force
}
function Read-Status {
  if (Test-Path -LiteralPath $StatusFile) {
    try { return Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json } catch { }
  }
  return New-Object PSObject
}
function Set-Status([string]$state, [string]$message, [hashtable]$extra = @{}) {
  $s = @{}
  $old = Read-Status
  foreach ($p in $old.PSObject.Properties) { $s[$p.Name] = $p.Value }
  $s.heartbeat = (Get-Date).ToUniversalTime().ToString('o')
  if ($state) { $s.state = $state }
  if ($message) { $s.message = $message }
  $s.log = @($script:Log | Select-Object -Last 40)
  foreach ($k in $extra.Keys) { $s[$k] = $extra[$k] }
  Write-Utf8 $StatusFile (ConvertTo-Json $s -Depth 4)
}
function Say([string]$msg) {
  Write-Host $msg
  [void]$script:Log.Add("$((Get-Date).ToString('HH:mm:ss'))  $msg")
}

# Run a native program, logging its output; throws if it fails.
function Invoke-Native([string]$exe, [string[]]$arguments, [string]$what) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # stderr from native tools must not become a terminating error
  try {
    & $exe @arguments 2>&1 | ForEach-Object {
      $line = "$_".TrimEnd()
      if ($line) { Write-Host "  $line"; [void]$script:Log.Add("  $line") }
    }
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { throw "$what failed (exit code $code). See the messages above." }
}

# ---------------------------------------------------------------- docker
function Test-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & docker info *> $null; return ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $prev }
}

function Wait-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    if (-not $NoPrompt) { Start-Process 'https://www.docker.com/products/docker-desktop/' }
    throw 'Docker Desktop is not installed. Install it, start it once, then try again.'
  }
  if (Test-Docker) { return }
  $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if ($OnWindows -and (Test-Path -LiteralPath $exe)) { Say 'Starting Docker Desktop...'; Start-Process -FilePath $exe }
  Say 'Waiting for Docker to be ready (this can take a minute)...'
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 3
    if (Test-Docker) { return }
  }
  throw 'Docker did not start. Open Docker Desktop, wait for "Engine running", and try again.'
}

function Get-LocalCommit {
  if ((Test-Path -LiteralPath (Join-Path $Root '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $c = (& git -C $Root rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $c) { return "$c".Trim() }
  }
  if (Test-Path -LiteralPath $CommitFile) { return (Get-Content -LiteralPath $CommitFile -Raw).Trim() }
  return ''
}

function Invoke-Compose([string[]]$arguments, [string]$what) {
  # The build stamps the version into the image so the web page can tell when an update is available.
  $env:MARQUEE_COMMIT = Get-LocalCommit
  $env:MARQUEE_BUILT_AT = (Get-Date).ToUniversalTime().ToString('o')
  Invoke-Native 'docker' (@('compose') + $arguments) $what
}

function Wait-Healthy {
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://localhost:$Port/api/health"
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

# ---------------------------------------------------------------- commands
function Start-Marquee {
  Wait-Docker
  if (-not (Test-Path -LiteralPath (Join-Path $Root '.env'))) {
    Copy-Item -LiteralPath (Join-Path $Root '.env.example') -Destination (Join-Path $Root '.env')
    if (-not $NoPrompt) {
      Write-Host ''
      Write-Host '  First run: Notepad will open your settings file.'
      Write-Host '  Set MOVIES_DIR, TV_DIR and YOUTUBE_DIR to your folders, e.g. D:/Movies'
      Write-Host '  then SAVE and CLOSE Notepad to continue.'
      Write-Host ''
      Start-Process -FilePath notepad.exe -ArgumentList '.env' -Wait
    }
    $script:DotEnv = Read-DotEnv
    $script:Port = Get-Setting 'MARQUEE_PORT' '32500'
  }
  Say 'Building and starting Marquee (the first time takes a few minutes)...'
  Invoke-Compose @('up', '-d', '--build') 'Starting Marquee'
  Say 'Waiting for Marquee to come up...'
  if (-not (Wait-Healthy)) { Say 'Marquee is taking a while to start. Run marquee-logs.bat to see what it is doing.' }
  if (-not $NoPrompt) { Start-Process "http://localhost:$Port" }
  Write-Host ''
  Write-Host "  Marquee is running:  http://localhost:$Port"
  Write-Host "  Other devices on your network:  http://$($env:COMPUTERNAME):$Port"
  Write-Host '  (allow Docker through Windows Firewall if your phone/TV cannot connect)'
  Write-Host ''
  Offer-Helper
}

function Stop-Marquee {
  Wait-Docker
  Say 'Stopping Marquee...'
  Invoke-Native 'docker' @('compose', 'down') 'Stopping Marquee'
  Say 'Stopped. Your libraries, users and watch history are kept.'
}

# Bring the files up to date: git pull for clones, otherwise download the branch as a ZIP.
function Update-Code {
  $before = Get-LocalCommit
  $isClone = (Test-Path -LiteralPath (Join-Path $Root '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)
  if ($isClone) {
    Say 'Getting the latest code with git...'
    Invoke-Native 'git' @('-C', $Root, 'pull', '--ff-only', 'origin', $Branch) 'git pull (do you have local changes?)'
  } else {
    Say "Downloading the latest version from github.com/$Repo..."
    $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -Headers @{ 'User-Agent' = 'marquee-updater' }
    if ($before -and $latest.sha -eq $before) { Say 'Already up to date.'; return @{ before = $before; after = $before; changed = $false } }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("marquee-update-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      $zip = Join-Path $tmp 'marquee.zip'
      Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/$Repo/zip/$($latest.sha)" -OutFile $zip
      Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'x') -Force
      $src = Get-ChildItem -LiteralPath (Join-Path $tmp 'x') -Directory | Select-Object -First 1
      if (-not $src -or -not (Test-Path -LiteralPath (Join-Path $src.FullName 'server.js'))) { throw 'The download does not look like Marquee.' }
      # Your settings, media and the helper's own folder are never touched.
      $keep = @('.env', 'control', 'media', 'data', '.git')
      foreach ($item in Get-ChildItem -LiteralPath $src.FullName -Force) {
        if ($keep -contains $item.Name) { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $Root -Recurse -Force
      }
      Write-Utf8 $CommitFile $latest.sha
    } finally {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $after = Get-LocalCommit
  return @{ before = $before; after = $after; changed = ($before -ne $after) }
}

function Update-Marquee {
  $script:Log.Clear()
  Set-Status 'updating' 'Downloading the latest version...' @{ startedAt = (Get-Date).ToUniversalTime().ToString('o'); finishedAt = $null }
  try {
    $r = Update-Code
    $short = if ($r.after) { $r.after.Substring(0, [Math]::Min(7, $r.after.Length)) } else { 'unknown' }
    Say "Version: $short"
    Wait-Docker
    Set-Status 'updating' 'Rebuilding Marquee (this can take a few minutes)...'
    Invoke-Compose @('build', '--pull') 'Rebuilding'
    Set-Status 'updating' 'Restarting Marquee...'
    Invoke-Compose @('up', '-d') 'Restarting'
    Say 'Update complete.'
    Set-Status 'done' "Updated to $short" @{ finishedAt = (Get-Date).ToUniversalTime().ToString('o'); commit = $r.after }
  } catch {
    Say "Update failed: $($_.Exception.Message)"
    Set-Status 'failed' $_.Exception.Message @{ finishedAt = (Get-Date).ToUniversalTime().ToString('o') }
    throw
  }
}

# The helper: heartbeat + wait for the web page to ask for an update.
function Watch-Updates {
  $mutex = New-Object System.Threading.Mutex($false, 'MarqueeUpdateHelper')
  if (-not $mutex.WaitOne(0)) { Write-Host 'The update helper is already running.'; return }
  try {
    $st = Read-Status
    if ($st.state -eq 'updating') { Set-Status 'failed' 'The previous update was interrupted.' } else { Set-Status $null $null }
    while ($true) {
      if (Test-Path -LiteralPath $RequestFile) {
        Remove-Item -LiteralPath $RequestFile -Force
        try { Update-Marquee } catch { }
      } else {
        Set-Status $null $null
      }
      if ($Once) { break }
      Start-Sleep -Seconds 15
    }
  } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
}

function Install-Helper {
  if (-not $OnWindows) { throw 'The automatic helper is for Windows. Elsewhere, run "pwsh marquee.ps1 Watch" in the background.' }
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action = New-ScheduledTaskAction -Execute $ps -WorkingDirectory $Root `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" Watch -NoPrompt' -f $PSCommandPath)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Lets the Marquee web page update Marquee (Settings > Updates > Update now).' -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Say "Update helper installed. It runs in the background whenever you're signed in to Windows."
}

function Remove-Helper {
  if (-not $OnWindows) { return }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Say 'Update helper removed.'
  } else { Say 'The update helper is not installed.' }
}

# Asked once after starting; the answer is remembered.
function Offer-Helper {
  if ($NoPrompt -or -not $OnWindows) { return }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { return }
  $declined = Join-Path $ControlDir 'helper-declined'
  if (Test-Path -LiteralPath $declined) { return }
  Write-Host '  Turn on one-click updates? A small helper will run in the background while you are'
  Write-Host '  signed in, so "Update now" in Settings > Updates can update Marquee for you.'
  $answer = Read-Host '  Turn it on? [Y/n]'
  if ($answer -match '^(n|no)$') {
    Write-Utf8 $declined 'You can turn it on later with: powershell -ExecutionPolicy Bypass -File marquee.ps1 InstallHelper'
    Write-Host '  OK. You can still update with update-marquee.bat.'
  } else {
    try { Install-Helper } catch { Write-Host "  Could not install the helper: $($_.Exception.Message)" }
  }
}

# ---------------------------------------------------------------- main
try {
  switch ($Command) {
    'Start' { Start-Marquee }
    'Stop' { Stop-Marquee }
    'Update' { Update-Marquee; Wait-Healthy | Out-Null; Say "Marquee is updated and running at http://localhost:$Port" }
    'Logs' { Wait-Docker; & docker compose logs -f --tail 200 }
    'Watch' { Watch-Updates }
    'InstallHelper' { Install-Helper }
    'RemoveHelper' { Remove-Helper }
  }
} catch {
  Write-Host ''
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
