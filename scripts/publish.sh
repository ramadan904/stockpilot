#!/usr/bin/env bash
# Publish the web app to Vercel from this checkout: Vercel builds it with every deployments/*.json baked in and
# serves it in production. Asks for the Vercel token hidden (or reads VERCEL_TOKEN), so it never lands on screen or in history.
#
#   bash scripts/publish.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${VERCEL_TOKEN:-}" ]; then
  # Asked again on an empty line: a pasted command often brings its own Enter.
  while [ -z "${VERCEL_TOKEN:-}" ]; do
    read -rs -p "Paste your Vercel token (nothing shows), then press Enter: " VERCEL_TOKEN || { echo; echo "No token given." >&2; exit 1; }
    echo
    VERCEL_TOKEN=$(printf %s "$VERCEL_TOKEN" | tr -d '[:space:]')
    if [[ "$VERCEL_TOKEN" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]; then
      echo "That is a wallet key, not a Vercel token. Copy the token from vercel.com/account/settings/tokens." >&2
      VERCEL_TOKEN=""
    fi
  done
fi

npx --yes vercel@latest deploy --prod --yes --token "$VERCEL_TOKEN"
