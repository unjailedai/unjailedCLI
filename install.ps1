# Unjailed CLI installer for Windows (PowerShell).
#   irm https://unjailedai.com/install.ps1 | iex
# Installs the `unjailed` npm package globally. Requires Node.js 20 or newer.
# Set $env:UNJAILED_VERSION to pin a version (default: latest).
$ErrorActionPreference = "Stop"

# Default to an explicit version rather than the "latest" tag: npm tag
# propagation can lag a fresh publish, landing users on the previous release.
$version = if ($env:UNJAILED_VERSION) { $env:UNJAILED_VERSION } else { "0.12.8" }
$pkg = "unjailed@$version"
$minNode = 20

function Write-Blue($msg) {
  if ($env:NO_COLOR) { Write-Host $msg } else { Write-Host $msg -ForegroundColor Cyan }
}
function Fail($msg) {
  Write-Host "error: $msg" -ForegroundColor Red
  exit 1
}

Write-Blue "Installing Unjailed CLI..."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js $minNode+ is required but wasn't found.`n  Install it with:  winget install OpenJS.NodeJS.LTS`n  (or from https://nodejs.org), then open a new terminal and run this again."
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt $minNode) {
  Fail "Node.js $minNode+ is required (you have $(node -v)). Upgrade with: winget upgrade OpenJS.NodeJS.LTS"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail "npm wasn't found. It normally ships with Node.js - reinstall Node and try again."
}

npm install -g $pkg --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit code $LASTEXITCODE)." }

Write-Host ""
Write-Blue "Unjailed CLI installed."
Write-Host "Run:  unjailed"
Write-Host "Then type /login and paste your API key from unjailedai.com/dashboard"
Write-Host "(If 'unjailed' isn't found, open a new terminal window so PATH refreshes.)"
