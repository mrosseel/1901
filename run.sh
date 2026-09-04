#!/usr/bin/env bash
# Build the frontend and the server, then serve the app.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${PORT:-8000}"
HOST="${HOST:-}"
DB="${DB:-1901.db}"

# NixOS carries no go or npm on PATH. Reach them through nix when they are
# absent, and use what is installed when it is there.
go_run() {
  if command -v go >/dev/null 2>&1; then go "$@"
  elif command -v nix >/dev/null 2>&1; then nix shell nixpkgs#go -c go "$@"
  else echo "run.sh: go not found, and nix is not available." >&2; exit 1
  fi
}

npm_run() {
  if command -v npm >/dev/null 2>&1; then npm "$@"
  elif command -v nix >/dev/null 2>&1; then nix shell nixpkgs#nodejs -c npm "$@"
  else echo "run.sh: npm not found, and nix is not available." >&2; exit 1
  fi
}

# The server prints "listening" before it learns the bind failed, so a taken
# port reads as a start that worked. Refuse here instead, and name the holder.
if command -v ss >/dev/null 2>&1; then
  holder="$(ss -ltnp "sport = :${PORT}" 2>/dev/null | tail -n +2 || true)"
  if [[ -n "${holder}" ]]; then
    echo "run.sh: port ${PORT} is already in use:" >&2
    echo "  ${holder}" >&2
    echo "run.sh: stop that process, or start on another port: PORT=8001 ./run.sh" >&2
    exit 1
  fi
fi

echo "run.sh: building the frontend"
(cd web && [ -d node_modules ] || npm_run install)
(cd web && npm_run run build)

echo "run.sh: building the server"
go_run build -o 1901srv ./cmd/1901

# An empty HOST listens on every interface, which is what a table needs: the
# invite QR names this machine's LAN address and the phones dial it.
export ADDR="${HOST}:${PORT}"
export DB
# The owner's door (ADR-060). Unset means there is no admin on this server,
# and every admin address answers 404. It is never printed.
if [[ -n "${ADMIN_TOKEN:-}" ]]; then
  export ADMIN_TOKEN
fi
echo "run.sh: serving on http://${HOST:-0.0.0.0}:${PORT}, database ${DB}"
exec ./1901srv "$@"
