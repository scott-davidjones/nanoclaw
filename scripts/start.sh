#!/usr/bin/env bash
# Start NanoClaw using the Node version declared in .nvmrc.
# Used by the systemd user unit so nvm upgrades don't silently break the service.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh" --no-use

nvm use --silent

exec node dist/index.js
