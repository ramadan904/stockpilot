#!/usr/bin/env bash
# From zero to live in one command: deploy StockPilot to the testnets, push real stock prices onto their feeds, seed a
# funded demo vault on each, build the web app with those deployments baked in, and publish it on Vercel.
#
#   PRIVATE_KEY=<throwaway testnet key, funded on each network> VERCEL_TOKEN=<token> ./scripts/go-live.sh
#
# Optional: NETWORKS (default "robinhoodTestnet arbitrumSepolia"), REDEPLOY=1 (deploy again even if
# deployments/<network>.json exists), REDEMO=1 (seed a new demo vault), ANTHROPIC_API_KEY (Claude drafts the demo
# vault's mandate; without it, the offline preset does). Safe to re-run: finished steps are skipped.
# Never use a key that holds real funds: this is a testnet deploy of unaudited contracts.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORKS=${NETWORKS:-"robinhoodTestnet arbitrumSepolia"}
: "${PRIVATE_KEY:?Set PRIVATE_KEY to a throwaway testnet key with testnet ETH on each network}"
field() { node -e "const d=require('./deployments/$1.json'); process.stdout.write(String(d['$2'] ?? ''))"; }

npx hardhat compile --quiet
for net in $NETWORKS; do
  echo "== $net"
  npx hardhat run scripts/preflight.ts --network "$net"
  if [ -f "deployments/$net.json" ] && [ -z "${REDEPLOY:-}" ]; then
    echo "Already deployed (deployments/$net.json); REDEPLOY=1 to deploy again."
  else
    npx hardhat run scripts/deploy.ts --network "$net"
  fi
  # Real stock prices from Pyth's Hermes API, once; the relayer service keeps them fresh afterwards.
  ONCE=1 npx hardhat run agent/relayer-run.ts --network "$net" || echo "warning: could not push prices on $net; the demo vault uses the listing prices until the relayer runs."
  if [ -n "$(field "$net" demoVault)" ] && [ -z "${REDEMO:-}" ]; then
    echo "Demo vault already seeded: $(field "$net" demoVault); REDEMO=1 for a new one."
  else
    DEMO=1 GOAL="${DEMO_GOAL:-Mostly the S&P 500, some big tech, and cash on hand.}" USD="${DEMO_USD:-10000}" \
      npx hardhat run scripts/create-vault.ts --network "$net"
  fi
done

npm run web:build
URL=""
if [ -n "${VERCEL_TOKEN:-}" ]; then
  URL=$(npx --yes vercel@latest deploy --prod --yes --token "$VERCEL_TOKEN" | tail -n 1)
else
  echo "VERCEL_TOKEN not set: skipping the Vercel deploy (the build is in web/dist)."
fi

echo
echo "== Live"
[ -n "$URL" ] && echo "App: $URL"
for net in $NETWORKS; do
  chain=$(field "$net" chainId)
  echo "$net (chain $chain): factory $(field "$net" factory), registry $(field "$net" registry)"
  vault=$(field "$net" demoVault)
  [ -n "$vault" ] && echo "  demo vault $vault${URL:+, read-only view: $URL/?chain=$chain&vault=$vault}"
done
echo
echo "Next: commit deployments/*.json so every build carries these addresses; keep prices fresh and the pilot flying"
echo "with 'docker compose up -d relayer fleet' (docs/OPERATIONS.md); on Vercel, set ANTHROPIC_API_KEY (Claude) and"
echo "SIGNATURE_RELAY_KEY (gasless check-in and pause) in the project's environment variables."
