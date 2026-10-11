#!/usr/bin/env bash
set -euo pipefail
cd /workspace/Adedonha
export npm_config_cache=/tmp/adedonha-npm-cache
export XDG_CONFIG_HOME=/tmp/adedonha-config
export WRANGLER_SEND_METRICS=false
export CI=true
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Adedonha requires Node.js 24 or newer")'
npm ci --no-audit --no-fund
npm run db:migrate
