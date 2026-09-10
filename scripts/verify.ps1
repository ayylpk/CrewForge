param([switch]$SkipBuilds)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $root "agents-CrewForge"
$frontend = Join-Path $root "fronted-CrewForge"
$backend = Join-Path $root "backed-CrewForge"
$bun = (Get-Command bun.exe -ErrorAction Stop).Source

function Run-Step([string]$Name, [scriptblock]$Command) {
    Write-Host "`n== $Name =="
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

Push-Location $engine
try {
    Run-Step "engine typecheck" { & $bun x tsc --noEmit }
    $smokes = @(
        "compile-gate-smoke.ts", "contracts-smoke.ts", "pm-ui-smoke.ts", "role-tier-smoke.ts",
        "render-smoke.ts", "t4-smoke.ts", "t7-smoke.ts", "t7b-smoke.ts",
        "dynamic-baseline-smoke.ts", "role-prompt-smoke.ts", "message-protocol-smoke.ts",
        "artifact-validation-smoke.ts", "core-team-smoke.ts",
        "db-idempotency-smoke.ts"
    )
    foreach ($smoke in $smokes) { Run-Step $smoke { & $bun run $smoke } }
} finally { Pop-Location }

if (-not $SkipBuilds) {
    Push-Location $frontend
    try { Run-Step "frontend build" { npm.cmd run build } } finally { Pop-Location }
    Push-Location $backend
    try { Run-Step "backend tests" { cmd.exe /c mvnw.cmd test -q } } finally { Pop-Location }
}

Push-Location $root
try { Run-Step "git diff check" { git diff --check } } finally { Pop-Location }
Write-Host "`nCrewForge verification passed."
