# Codex-Orchestra installer wrapper (PowerShell 5.1+).
param(
    [Parameter(Position = 0)]
    [string]$Target = ".",
    [string]$Packs = "",
    [string]$Specialists = "",
    [switch]$NoPacks,
    [switch]$NoSpecialists,
    [switch]$Uninstall,
    [string]$Scan = "",
    [switch]$Update,
    [int]$Depth = 0,
    [switch]$Lint
)

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Error "Node.js is required. Install it and ensure 'node' is on PATH."
    exit 1
}

$installArgs = @((Join-Path $PSScriptRoot "install.js"))
if ($Lint) {
    $installArgs += "--lint"
    if ($Target -ne ".") { $installArgs += $Target }
} elseif ($Scan -ne "") {
    $installArgs += @("--scan", $Scan)
    if ($Update) { $installArgs += "--update" }
    if ($Depth -gt 0) { $installArgs += @("--depth", "$Depth") }
} else {
    $installArgs += $Target
    if ($Packs -ne "") { $installArgs += @("--packs", $Packs) }
    if ($NoPacks) { $installArgs += "--no-packs" }
    if ($Specialists -ne "") { $installArgs += @("--specialists", $Specialists) }
    if ($NoSpecialists) { $installArgs += "--no-specialists" }
    if ($Uninstall) { $installArgs += "--uninstall" }
}

& node @installArgs
exit $LASTEXITCODE
