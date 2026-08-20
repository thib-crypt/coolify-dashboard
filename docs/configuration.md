# Configuration

Everything is environment variables. Two are required; the rest have defaults chosen so
that the dashboard is useful, honest and cheap out of the box.

The BFF reads a `.env` file in its working directory at startup (through Node's own
`process.loadEnvFile`, no dotenv dependency), and any variable already set in the
environment wins over the file. [`.env.example`](../.env.example) is the same reference as
this page, inline and copy-pasteable.

## Required

| Variable | Example | Notes |
|---|---|---|
| `COOLIFY_URL` | `https://coolify.example.com` | Instance root. A trailing slash or an `/api/v1` suffix is stripped for you. |
| `COOLIFY_TOKEN` | `1|abc…` | From `Security → API Tokens`. Its abilities decide what the UI can do — see [coolify-setup.md](coolify-setup.md#3-create-a-token). |

Missing either one is not a crash: `/app/overview` answers `503 not_configured`, and the
SPA renders the error with the next step. Everything else keeps working, including
`npm run dev:mock`, which needs no instance at all.

## The server

| Variable | Default | What it does |
|---|---|---|
| `BFF_PORT` | `8787` | Port to listen on. Takes precedence over `PORT`, which dev tooling likes to inject. |
| `BFF_HOST` | `127.0.0.1` | Interface to bind. Loopback by default, because a dashboard with no `DASHBOARD_PASSWORD` is an unauthenticated write API. The container sets `0.0.0.0` and warns at boot if it does that without a password. |
| `STATIC_DIR` | `dist` | Built SPA to serve alongside the API. Set it to empty to run the BFF API-only; a directory with no `index.html` is ignored (which is what development wants — Vite serves the front end there). |
| `DATA_DIR` | `./data` | Where `dashboard.sqlite` lives: KPI history and uptime samples. Back this up, or accept that both restart from zero. |
| `COOLIFY_TIMEOUT_MS` | `10000` | Budget for one upstream request. |
| `DEPLOYMENT_HISTORY_TAKE` | `20` | Deployments pulled per application when building the 24 h history. Raise it if your busiest app deploys more than 20 times a day, at a proportional cost upstream. |

If `node:sqlite` is unavailable in your runtime, the store falls back to an in-process ring
buffer: the dashboard renders identically but forgets its history on restart. Node 24+ has
it out of the box.

## The front door

| Variable | Default | What it does |
|---|---|---|
| `DASHBOARD_PASSWORD` | *(empty)* | Sets the password the dashboard asks for. Empty leaves **every route open**, which is the pre-1.0 behaviour and is only safe on loopback or a private network. |
| `SESSION_SECRET` | *(the password)* | Key that signs the session cookie. Defaulting to the password means changing the password signs everyone out; set it explicitly if you would rather it did not, or if several replicas must accept each other's cookies. |
| `SESSION_TTL_HOURS` | `168` | How long a session lasts before the password is asked for again. |

One password, no user list: this is a companion to one Coolify instance, and the API token
it already holds is a single shared credential. The password is exchanged once at
`POST /app/session` for an `HttpOnly`, `SameSite=Lax` cookie carrying a signed expiry — no
server-side session store, so restarting the container does not sign anyone out.

Ten failed attempts shut the door for five minutes. The counter is keyed on the connecting
address, which behind a reverse proxy is the proxy: the throttle is then effectively global,
because trusting `X-Forwarded-For` instead would let an attacker rotate the header and never
be throttled at all.

What stays reachable without a session: `GET /app/health` (a container health check needs
it — it answers a thin body until you sign in), and `POST /app/hooks/coolify`, which
authenticates with `WEBHOOK_SECRET` because Coolify cannot hold a cookie.

## The live channel

| Variable | Default | What it does |
|---|---|---|
| `WEBHOOK_SECRET` | *(empty)* | Enables `POST /app/hooks/coolify` and is the **only** authentication on it, since Coolify's outgoing webhooks are unsigned. Empty means the route answers `503` and updates arrive by polling — slower, never blind. |
| `POLL_ACTIVE_MS` | `2500` | How often the running deployments are read while a build is in progress. |
| `POLL_IDLE_MS` | `4000` | Same, while nothing is building. **This value is the latency** with which a deployment started from Coolify's own UI appears here, because Coolify emits no webhook when a build *begins*. |

The poller stops entirely while no browser is connected, so a raised cadence costs nothing
when nobody is watching. See [architecture.md](architecture.md#the-live-channel).

## Probes — uptime, latency, certificates

These requests go to **your own applications**, not to the Coolify API, so they spend none
of its rate-limit budget. Unlike the poller, the loop keeps running with no browser
connected: an uptime measured only while someone is looking is not an uptime.

| Variable | Default | What it does |
|---|---|---|
| `PROBES_ENABLED` | `true` | Turns the whole prober off when false. Uptime, latency and certificate expiry then show `—` and say so, rather than being estimated. |
| `PROBE_INTERVAL_MS` | `60000` | How often each application's public domain is checked over HTTP, and each server TCP-pinged. Every result is one row in SQLite. |
| `PROBE_TIMEOUT_MS` | `5000` | A probe that exceeds this counts as an outage. |
| `PROBE_TLS_INTERVAL_MS` | `3600000` | How often the TLS certificate of each `https` domain is re-read. Hourly is plenty — an expiry date does not move in a minute. |
| `PROBE_CONCURRENCY` | `6` | How many probes run at once. |
| `PROBE_RETENTION_DAYS` | `7` | How long samples are kept. Uptime is always computed over the last 24 h; the extra days are there for you to query. |
| `PROBE_APPS` | *(all)* | Comma-separated names or uuids to restrict probing to. Useful when some domains are behind a VPN, rate-limited, or not yours to hammer. |

Two guards against crying wolf are not configurable on purpose: **3 consecutive failures**
before an application is called down, and **5 samples** before any percentage is shown.

## Server metrics (Sentinel over SSH)

Coolify exposes no REST endpoint for CPU or RAM. Setting `METRICS_SSH_KEY` is what opts you
into the same SSH round trip Coolify's own charts make; with no key, the collector never
runs and costs **zero** extra upstream requests.

| Variable | Default | What it does |
|---|---|---|
| `METRICS_SSH_KEY` | *(empty)* | Path to a private key the servers accept. Setting it **is** the opt-in. |
| `METRICS_ENABLED` | *(follows the key)* | Overrides that in either direction. `false` keeps the collector off with a key present; `true` runs it without one, which only makes sense outside a container where `ssh` finds an identity through an agent or `~/.ssh/config`. |
| `METRICS_INTERVAL_MS` | `30000` | How often each server is queried. Like the poller, this loop stops while no browser is connected — a gauge accumulates no history, so a reading nobody sees is a wasted SSH connection. |
| `METRICS_TIMEOUT_MS` | `12000` | Whole budget for one server: SSH handshake plus both `curl`s. |
| `METRICS_SSH_USER` | *(per server)* | Login to use. Empty means whatever `GET /servers` reports for each server. |
| `METRICS_SSH_STRICT_HOST_KEY` | `accept-new` | Host-key policy. `accept-new` pins each server on first sight. `no` disables server authentication entirely — only for an ephemeral container with no writable `known_hosts`, and the BFF warns at startup when you do. |
| `METRICS_CONCURRENCY` | `3` | How many servers are queried at once. |
| `METRICS_HISTORY_MINUTES` | `5` | How much history to ask Sentinel for. Only the newest point is displayed, and a point older than two minutes is reported as *stale* instead of as current. |
| `METRICS_SERVERS` | *(all)* | Comma-separated names or uuids to restrict collection to. |

Requirements on the instance side are in
[coolify-setup.md](coolify-setup.md#5-optional--cpu-and-ram-gauges-sentinel).

## Front-end

| Variable | Default | What it does |
|---|---|---|
| `VITE_USE_MOCK` | *(unset)* | `1` builds/serves the SPA against fixture data, with no BFF and no instance. `npm run dev:mock` sets it for you. |

## Cache TTLs

Not environment variables — they are constants in
[`server/cache.ts`](../server/cache.ts), listed here because they explain the dashboard's
upstream cost. Each family is fetched at most once per TTL no matter how many tabs ask,
with single-flight coalescing and a stale-value fallback if Coolify goes down mid-refresh.

| Family | TTL |
|---|---|
| `version` | 10 min |
| `team`, `projects`, `environments`, `scheduledTasks`, `databases` | 5 min |
| `applicationDetail` (per application) | 5 min, invalidated on write |
| `deploymentHistory` | 2 min |
| `servers` | 60 s |
| `applications` | 30 s |
| `deployments` | 5 s |

The resulting budget is in [roadmap.md](roadmap.md#appendix-b--the-rate-limit-budget).
