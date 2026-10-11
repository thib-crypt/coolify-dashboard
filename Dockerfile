# syntax=docker/dockerfile:1

# The whole dashboard is one container: the BFF serves the built SPA and the
# JSON it needs from the same origin, so there is no CORS to configure and the
# Coolify token never leaves this process.

# ---------------------------------------------------------------- build ----
FROM node:26-alpine AS build
WORKDIR /app

# Dependencies first: this layer is rebuilt only when the lockfile moves.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Type-checks both projects, bundles the SPA into dist/ and the BFF into
# dist-server/ — a single ESM file with its dependencies bundled in.
RUN npm run build

# -------------------------------------------------------------- runtime ----
FROM node:26-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    BFF_HOST=0.0.0.0 \
    BFF_PORT=8787 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist

# `ssh` is used by one optional feature — the Sentinel metrics collector, which
# only runs when METRICS_SSH_KEY is set. It costs about a megabyte here, and its
# absence would surface much later as a puzzling empty gauge.
RUN apk add --no-cache openssh-client \
 && mkdir -p /data \
 && chown node:node /data

# No node_modules: the server bundle carries its dependencies. `package.json`
# still comes along — it is what tells Node that a `.js` file is an ES module.
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 8787

# KPI history and uptime samples live here. Without a volume the dashboard still
# runs; it just starts measuring again from zero on every restart.
VOLUME ["/data"]

# `ok: false` is a legitimate state — Coolify unreachable, token missing — and
# must not restart the container. What this asks is whether the BFF still
# answers at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BFF_PORT||8787)+'/app/health').then(r=>r.json()).then(b=>process.exit(b.service?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.js"]
