# syntax=docker/dockerfile:1
# One image for StockPilot's long-running services: the fleet pilot and the testnet price relayer.
# See docs/OPERATIONS.md. Build: docker build -t stockpilot .
# Behind a TLS-intercepting proxy, pass its CA for the install step: --secret id=ca,src=/path/to/ca.pem
FROM node:22-slim

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HARDHAT_DISABLE_TELEMETRY_PROMPT=true \
    HEALTH_PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi && \
    npm ci --no-audit --no-fund && npm cache clean --force

COPY hardhat.config.ts tsconfig.json ./
COPY contracts contracts
COPY agent agent
COPY scripts scripts
COPY web/src/abi.ts web/src/abi.ts
# Compile once at build time with the bundled solc-js, so containers start without compiling.
RUN npx hardhat compile && mkdir -p deployments pilot-log && chown -R node:node /app

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.HEALTH_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Default: the fleet pilot. The network comes from HARDHAT_NETWORK; pass agent/relayer-run.ts to run the relayer.
# What `hardhat run` does in its child process, without the wrapper processes: neither npx nor `hardhat run` passes
# SIGTERM on, and the services need it to finish the current tick before exiting.
ENTRYPOINT ["node", "--require", "ts-node/register/transpile-only", "--require", "hardhat/register"]
CMD ["agent/fleet-run.ts"]
