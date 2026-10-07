#!/usr/bin/env bash
# From zero to live in one command: deploy StockPilot to the testnets, push real stock prices onto their feeds, seed a
# funded demo vault on each, build the web app with those deployments baked in, and publish it on Vercel.
#
#   ./scripts/go-live.sh   (asks for the deploy key and Vercel token, hidden, unless PRIVATE_KEY / VERCEL_TOKEN are set)
#
# Optional: NETWORKS (default "robinhoodTestnet arbitrumSepolia"), REDEPLOY=1 (deploy again even if
# deployments/<network>.json exists), REDEMO=1 (seed a new demo vault; DEMO_CASH=1 funds it in cash for the pilot to invest), ANTHROPIC_API_KEY (Claude drafts the demo
# vault's mandate; without it, the offline preset does). Safe to re-run: finished steps are skipped.
# Never use a key that holds real funds: this is a testnet deploy of unaudited contracts.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORKS=${NETWORKS:-"robinhoodTestnet arbitrumSepolia"}
# Secrets not in the environment are asked for here, hidden, so they never land on screen or in shell history.
clean_key() { local k; k=$(printf %s "$1" | tr -d '[:space:]'); k=${k#0x}; [[ "$k" =~ ^[0-9a-fA-F]{64}$ ]] && printf %s "$k"; }
if [ -n "${PRIVATE_KEY:-}" ]; then
  key=$(clean_key "$PRIVATE_KEY") || { echo "PRIVATE_KEY is not a private key (a key is 64 letters and digits)." >&2; exit 1; }
else
  # Asked again on an empty line (a pasted command often carries its own Enter) or anything that is not a key.
  for _ in 1 2 3 4 5; do
    read -rs -p "Paste the deploy key (a throwaway testnet key; nothing shows), then press Enter: " input && echo
    [ -z "${input//[[:space:]]/}" ] && continue
    key=$(clean_key "$input") && break
    echo "That is not a private key (a key is 64 letters and digits). Copy it again from your wallet." >&2
  done
  [ -n "${key:-}" ] || { echo "No deploy key given." >&2; exit 1; }
  unset input
fi
export PRIVATE_KEY="0x$key"
if [ -z "${VERCEL_TOKEN:-}" ] && [ -t 0 ]; then
  while :; do
    read -rs -p "Paste your Vercel token to publish the app (nothing shows), or type skip: " VERCEL_TOKEN || { VERCEL_TOKEN=""; break; }
    echo
    VERCEL_TOKEN=$(printf %s "$VERCEL_TOKEN" | tr -d '[:space:]')
    [ -z "$VERCEL_TOKEN" ] && continue
    [ "$VERCEL_TOKEN" = skip ] && { VERCEL_TOKEN=""; break; }
    clean_key "$VERCEL_TOKEN" >/dev/null && { echo "That is the deploy key, not a Vercel token. Copy the token from vercel.com/account/settings/tokens." >&2; continue; }
    break
  done
  export VERCEL_TOKEN
fi
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
    DEMO=1 CASH="${DEMO_CASH:-}" GOAL="${DEMO_GOAL:-Mostly the S&P 500, some big tech, and cash on hand.}" USD="${DEMO_USD:-10000}" \
      npx hardhat run scripts/create-vault.ts --network "$net"
  fi
  # Verified Mandate, for deployments that predate it (a no-op otherwise).
  npx hardhat run scripts/deploy-credential.ts --network "$net"
  # The demo vault flies with a pilot of its own, never its owner (a no-op once it has one).
  npx hardhat run scripts/demo-pilot.ts --network "$net"
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
