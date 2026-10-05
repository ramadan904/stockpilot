# Running the services

StockPilot has two long-running services, packaged in one Docker image:

| Service | Script | Key it holds | What it does |
|---|---|---|---|
| **fleet** | [`agent/fleet-run.ts`](../agent/fleet-run.ts) | The pilot key | Every `INTERVAL` seconds, finds every vault that names this pilot and rebalances the ones that drifted, inside their mandates. Collects management fees, sends owner alerts and daily digests. |
| **relayer** | [`agent/relayer-run.ts`](../agent/relayer-run.ts) | The deployer key (testnet only) | Pushes real stock prices from Pyth's Hermes API onto the testnet's mock price feeds. Not used on a chain with real feeds. |

The pilot key can only trade inside each vault's onchain mandate: it cannot withdraw, change a mandate or unpause.
Leaking it lets an attacker make trades the owner already allowed, nothing more. Even so, keep it in a secret
store, not in the image or the repository.

## Quick start

```bash
cp .env.example .env            # set NETWORK, PRIVATE_KEY (pilot), RELAYER_PRIVATE_KEY, optional alerts
npm run deploy:robinhood-testnet   # once, from a machine with the deployer key; writes deployments/<network>.json
docker compose up -d fleet relayer
curl localhost:8080/health      # fleet
curl localhost:8081/health      # relayer
```

Both services read `deployments/<network>.json`, which compose mounts from the host. The fleet appends each trade's
rationale to the `pilot-log` volume.

### Try it locally, no keys

```bash
docker compose --profile local up -d          # a Hardhat chain, the stack, one funded vault, and the fleet pilot
curl localhost:8080/metrics
docker compose run --rm --no-deps -e SYMBOL=NVDA -e PCT=40 --entrypoint node setup \
  --require ts-node/register/transpile-only --require hardhat/register scripts/move-price.ts
docker compose --profile local logs -f local-fleet   # the pilot sells some NVDA within 15 seconds
docker compose --profile local down -v
```

`scripts/docker-smoke.sh` does exactly this and checks every step; CI runs it on every push.

## Health and metrics

Set `HEALTH_PORT` (the image sets 8080) and each service serves:

- **`GET /health`**: `200 {"status":"ok",...}` while ticks complete; `503 {"status":"stale",...}` once no tick has
  succeeded for three intervals (at least a minute). The body carries `lastError`. The image's `HEALTHCHECK` and
  compose use it, so a wedged service shows as unhealthy; restart it, or alert on it.
- **`GET /metrics`**, Prometheus text:

| Metric | Type | Meaning |
|---|---|---|
| `stockpilot_ticks_total{service}` | counter | Ticks that completed |
| `stockpilot_failed_ticks_total{service}` | counter | Ticks that threw (RPC down, Hermes unreachable). The service keeps going. |
| `stockpilot_last_tick_timestamp_seconds{service}` | gauge | When the last tick completed |
| `stockpilot_events_total{service,kind}` | counter | fleet: `trade`, `hold`, `skip`, `error`, `fee`, `digest`, `check_in_reminder`, `defensive` (a crash guard it tripped). relayer: `pushed`, `skipped`, `missing_quote` |
| `stockpilot_vaults{service="fleet"}` | gauge | Vaults that name this pilot |

Alerts worth having: `time() - stockpilot_last_tick_timestamp_seconds > 300`, a rising `failed_ticks_total`, and any
`kind="error"` on the fleet (a vault the pilot could not fly; the reason is in the logs and in the owner's alert).

## Stopping and upgrading

`docker compose stop` sends SIGTERM. A service finishes its current tick, including any transaction it is waiting
on, then exits 0; compose allows two minutes. It never stops halfway between sending a trade and recording it.
The image runs the scripts with `node` directly because `npx` and `hardhat run` do not pass SIGTERM on to them.

Upgrades are a rebuild and a restart: `docker compose build && docker compose up -d`. The services keep no state
except the pilot log; budgets, cooldowns and fees all live onchain.

## Configuration

Everything is environment variables; [`.env.example`](../.env.example) lists them with defaults. The ones that matter:

| Variable | Service | Default | |
|---|---|---|---|
| `NETWORK` | both | `robinhoodTestnet` | A network in `hardhat.config.ts` |
| `PRIVATE_KEY` | fleet | | The pilot key |
| `RELAYER_PRIVATE_KEY` | relayer | | The deployer key, which owns the mock feeds |
| `INTERVAL` | both | 60 / 30 s | Seconds between ticks |
| `MIN_FEE_BPS` | fleet | 0 | Fly only vaults paying at least this fee to this pilot; also the fee the marketplace listing asks |
| `PILOT_NAME`, `PILOT_URI` | fleet | | List this pilot in the `PilotRegistry` at start-up (and update the listing when these change) |
| `WEBHOOK_URL` | fleet | | Operator alerts (Slack, Discord, any JSON endpoint) |
| `SUBSCRIPTIONS`, `RESEND_API_KEY`, `ALERT_FROM` | fleet | | Owner alerts by email and webhook, signed by owners ([`agent/alerts.ts`](../agent/alerts.ts)) |
| `ANTHROPIC_API_KEY` | fleet | | Claude-written daily digests; without it, digests are plain |
| `PYTH_IDS`, `HERMES_URL`, `DEVIATION_BPS`, `HEARTBEAT` | relayer | | Price sources and push rules |
| `ONCE` | both | | Run one tick and exit, non-zero if it failed (for cron) |

Building behind a TLS-intercepting proxy: `docker build --secret id=ca,src=/path/to/ca.pem -t stockpilot .` hands the
proxy's CA to `npm ci` without putting it in the image.

## Without Docker

```bash
HEALTH_PORT=8080 PRIVATE_KEY=<pilot> npm run fleet -- --network robinhoodTestnet
HEALTH_PORT=8081 PRIVATE_KEY=<deployer> npm run relay -- --network robinhoodTestnet
```

Under systemd or another supervisor, run `node --require ts-node/register/transpile-only --require hardhat/register
agent/fleet-run.ts` with `HARDHAT_NETWORK` set, for the same SIGTERM handling as the image.
