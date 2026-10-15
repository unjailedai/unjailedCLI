#!/bin/sh
# Unjailed CLI installer for macOS and Linux.
#   curl -fsSL https://unjailedai.com/install.sh | sh
# Installs the `unjailed` npm package globally. Requires Node.js 20 or newer.
# Set UNJAILED_VERSION to pin a version (default: latest).
set -eu

# Explicit version: npm "latest" tag propagation can lag a fresh publish.
PKG="unjailed@${UNJAILED_VERSION:-0.12.14}"
MIN_NODE=20

blue() { printf '\033[38;2;125;211;252m%s\033[0m\n' "$1"; }
err() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
[ -n "${NO_COLOR:-}" ] && blue() { printf '%s\n' "$1"; }

blue "Installing Unjailed CLI…"

if ! command -v node >/dev/null 2>&1; then
  err "Node.js ${MIN_NODE}+ is required but wasn't found.
  macOS:  brew install node
  Linux:  https://nodejs.org/en/download (or your package manager / nvm)
Then run this installer again."
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
  err "Node.js ${MIN_NODE}+ is required (you have $(node -v)). Please upgrade and run this again."
fi

command -v npm >/dev/null 2>&1 || err "npm wasn't found. It normally ships with Node.js — reinstall Node and try again."

if npm install -g "$PKG" --no-fund --no-audit --loglevel=error; then
  :
else
  # Global prefix not writable (common with system Node). Fall back to a user prefix — never sudo.
  PREFIX="$HOME/.local"
  blue "Global install needs permissions; installing to $PREFIX instead."
  npm install -g "$PKG" --prefix "$PREFIX" --no-fund --no-audit --loglevel=error || err "npm install failed."
  case ":$PATH:" in
    *":$PREFIX/bin:"*) ;;
    *) printf '\nAdd this to your shell profile (~/.bashrc, ~/.zshrc):\n  export PATH="%s/bin:$PATH"\n' "$PREFIX" ;;
  esac
fi

echo
blue "✓ Unjailed CLI installed."
echo "Run:  unjailed"
echo "Then type /login and paste your API key from unjailedai.com/dashboard"
