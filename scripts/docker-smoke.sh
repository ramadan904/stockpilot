#!/usr/bin/env bash
# End-to-end check of the service image: a local chain, the stack and a vault in containers; the fleet pilot must list
# itself in the pilot marketplace, report healthy, trade after a 40% rally, count it in /metrics, and stop on SIGTERM.
# Extra `docker build` flags (e.g. a proxy CA secret) go in BUILD_FLAGS.
set -euo pipefail
cd "$(dirname "$0")/.."
export FLEET_PORT=${FLEET_PORT:-8080}
compose() { docker compose --profile local "$@"; }
trap 'compose logs --no-color > docker-smoke.log 2>&1 || true; compose down -v > /dev/null 2>&1 || true' EXIT

# shellcheck disable=SC2086
docker build ${BUILD_FLAGS:-} -t stockpilot .
compose up -d chain setup local-fleet

wait_for() { # seconds, description, command...
  local t=$1 what=$2; shift 2
  for _ in $(seq 1 "$t"); do "$@" > /dev/null 2>&1 && return 0; sleep 1; done
  echo "timed out waiting for $what" >&2; return 1
}
metrics() { curl -sf "localhost:$FLEET_PORT/metrics"; }
wait_for 120 "a first tick" sh -c "curl -sf localhost:$FLEET_PORT/metrics | grep -q 'ticks_total.* [1-9]'"
curl -sf "localhost:$FLEET_PORT/health"; echo
compose logs --no-color local-fleet | grep -q "Listed in the pilot registry" || { echo "the fleet did not list itself" >&2; exit 1; }

compose run --rm --no-deps -e SYMBOL=NVDA -e PCT=40 --entrypoint node setup \
  --require ts-node/register/transpile-only --require hardhat/register scripts/move-price.ts
wait_for 120 "a trade" sh -c "curl -sf localhost:$FLEET_PORT/metrics | grep -q 'kind=\"trade\"'"
metrics | grep stockpilot_events_total

compose stop local-fleet
compose logs --no-color local-fleet | tail -3
code=$(docker inspect "$(compose ps -aq local-fleet)" --format '{{.State.ExitCode}}')
grep -q "SIGTERM received" <(compose logs --no-color local-fleet) || { echo "no graceful stop" >&2; exit 1; }
[ "$code" = 0 ] || { echo "fleet exited with $code" >&2; exit 1; }
echo "docker smoke test passed"
