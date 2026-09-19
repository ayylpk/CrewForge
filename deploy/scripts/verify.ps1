param([switch]$SkipBuilds)

$ErrorActionPreference = "Stop"
# ⚠️ 9/18 目录重构：本脚本从 <根>/scripts/ 挪到 <根>/deploy/scripts/ —— 多退一级才是仓库根。
#    少退一级时 $root 会指到 <根>/deploy，三个 Join-Path 全部落空、脚本"跑完什么都没测"。
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$engine = Join-Path $root "agent/engine"
$frontend = Join-Path $root "frontend"
$backend = Join-Path $root "backend"
$bun = (Get-Command bun.exe -ErrorAction Stop).Source

function Run-Step([string]$Name, [scriptblock]$Command) {
    Write-Host "`n== $Name =="
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

Push-Location $engine
try {
    Run-Step "engine typecheck" { & $bun x tsc --noEmit }
    # 9/18 清理：17 个 *-smoke.ts 一次性自检脚本、engine/tests、developerAgent/tests、
    # testAgent/tests 与 eval/ 评测档已全部删除 —— 引擎侧不再有测试步骤，只留类型检查。
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
