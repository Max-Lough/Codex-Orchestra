# Compatibility wrapper for the canonical Codex-Orchestra installer.
& (Join-Path $PSScriptRoot "install.ps1") @args
exit $LASTEXITCODE
