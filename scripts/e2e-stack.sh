#!/usr/bin/env bash
# Everything the browser tests need: a local chain with StockPilot deployed, and the web app's dev server (which also
# serves /api/*). Playwright starts this and waits for http://localhost:5173. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."
npx hardhat node > /tmp/stockpilot-e2e-node.log 2>&1 &
NODE_PID=$!
trap 'kill $NODE_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -s -o /dev/null -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' http://127.0.0.1:8545 && break
  sleep 1
done
npx hardhat run scripts/deploy.ts --network localhost
exec npx vite web --port 5173 --strictPort
