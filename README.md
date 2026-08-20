<h1 align="center">coolify-dashboard</h1>

<p align="center">
  A real-time companion dashboard for a self-hosted <a href="https://coolify.io">Coolify</a> instance —
  <br>it shows what Coolify's API exposes, and <em>measures</em> what it doesn't.
</p>

<p align="center">
  <a href="https://github.com/thib-crypt/coolify-dashboard/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/thib-crypt/coolify-dashboard/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.5-5FA04E?logo=node.js&logoColor=white">
  <img alt="Coolify" src="https://img.shields.io/badge/coolify-v4-6366F1">
</p>

---

Coolify manages your servers, applications and deployments very well. What it does not
give you is a single screen that answers *"is everything fine right now?"* — fleet health,
running builds with live logs, uptime, expiring certificates and what needs attention,
all at once, with the actions to fix it one keystroke away.

This is that screen. It is a **companion app**, not a fork: a small container you deploy
next to Coolify (or on it), pointed at its REST API with a token.

```
┌──────────────┐   SSE + JSON   ┌───────────────────────────┐  Bearer token  ┌──────────────┐
│  React SPA   │ ◄───────────── │  BFF (Hono, TypeScript)   │ ─────────────► │ Coolify API  │
│              │    /app/*      │  · aggregates ~10 calls   │   /api/v1/*    │  (your box)  │
└──────────────┘                │  · adaptive poller + SSE  │                └──────┬───────┘
                                │  · uptime & TLS probes    │   outgoing webhooks   │
                                │  · SQLite history         │ ◄─────────────────────┘
                                └───────────────────────────┘
```

**The browser never talks to Coolify.** The API token stays in the server process, and one
BFF serves any number of tabs inside Coolify's 200 req/min budget — under 36 req/min in
steady state, and about 0.4 req/min when nobody has the dashboard open, because the poller
stops and only the probes' target list is still read.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Security](#security)
- [What is real, and what is an em dash](#what-is-real-and-what-is-an-em-dash)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Features

**Live, without a refresh button.** An adaptive poller (2.5 s while a build runs, 4 s
otherwise) and Coolify's outgoing webhooks both feed one SSE channel, deduplicated. A
deployment started from Coolify's own UI shows up here in about 3.6 s — Coolify emits no
webhook when a build *begins*, so that cadence is the detection latency, measured end to
end. Build logs scroll line by line, the timer is anchored to a real start instant, and the
Deploy button stays "Deploying" until the build actually ends. With no tab open, the poller
stops entirely and costs nothing.

**Act on what you see.** Deploy, hold-to-cancel a running build, restart or stop an
application, toggle auto-deploy, run a scheduled task — from the panel or from the ⌘K
palette. Coolify answers `200` even when it did nothing, so every action is reported as
`queued`, `done` or `skipped`, with Coolify's own wording in the toast and the cache the
write just invalidated purged, so a click is never invisible for minutes.

**Uptime that is a measurement.** Coolify knows whether *it* can reach a server over SSH.
That is not the same question as "does the site answer?", and there is no API for the
second one. So the BFF asks it: an HTTP probe per public domain every 60 s, a TLS handshake
every hour for certificate expiry, and a TCP ping per server for the latency the API never
exposes. Every result is a row in SQLite, so the percentage survives a restart — and the
loop keeps running with no browser connected, because an uptime measured only while someone
is watching is not an uptime.

**Insights that link to the fix.** A rule engine over the measured state — unreachable
server, full disk, stopped or unhealthy application, app that stopped answering, expiring
certificate, failed backup, repeated deployment failures, degraded uptime — sorted by
severity, deduplicated, and each one deep-linking to the exact Coolify page where it gets
resolved. When there are more findings than room, the last row *counts what it is hiding*.

**CPU and RAM, honestly.** Coolify has no REST endpoint for them; its own charts SSH into
each server and query the Sentinel agent. Give the BFF an SSH key and it makes the same
round trip. Give it nothing — the default — and the gauges stay empty while saying *which*
silence they are: no collector, Sentinel disabled on that server, a reading gone stale, or a
collector that tried and failed.

**Pages, not one screen.** The overview is a summary; every panel's *View all* opens the
full thing — applications, the whole deployment history, servers, the next 24 hours of
scheduled work. An application has its own page: runtime logs, environment variables,
deployment history and one-click rollback to an image already built on the server. All of
it shares a single live channel, so navigating costs no extra Coolify requests.

**The design.** Command palette, animated KPI sparklines, staggered entrances, delayed rail
tooltips, `prefers-reduced-motion` support, and breakpoints at 1020 / 680 px.

## Quick start

You need a Coolify v4 instance with its API enabled and a token —
**[docs/coolify-setup.md](docs/coolify-setup.md)** walks through it in five minutes. If
anything is off afterwards, the dashboard's own **setup check** says which of the four
identical-looking `403`s you have and links to the page that fixes it.

### Docker (recommended)

The image is published for `linux/amd64` and `linux/arm64`, so there is nothing to build:

```bash
docker run -d --name coolify-dashboard \
  -p 127.0.0.1:8787:8787 \
  -v coolify-dashboard-data:/data \
  -e COOLIFY_URL=https://coolify.example.com \
  -e COOLIFY_TOKEN=... \
  -e DASHBOARD_PASSWORD=... \
  ghcr.io/thib-crypt/coolify-dashboard:latest
```

Or with Compose, which also carries the optional settings as comments:

```bash
git clone https://github.com/thib-crypt/coolify-dashboard.git
cd coolify-dashboard
cp .env.example .env      # COOLIFY_URL, COOLIFY_TOKEN, DASHBOARD_PASSWORD
docker compose up -d
```

The dashboard is on <http://127.0.0.1:8787>. To run it *on* your Coolify instance as a
Docker Compose resource — with a domain, HTTPS and the outgoing webhook wired up — follow
**[docs/deployment.md](docs/deployment.md)**.

### From source

```bash
npm install
cp .env.example .env      # set COOLIFY_URL and COOLIFY_TOKEN
npm run dev               # SPA on :5180, BFF on :8787, /app proxied between them
```

Other scripts:

| Command | What it does |
|---|---|
| `npm run dev` | SPA + BFF together, both watching |
| `npm run dev:mock` | SPA alone on fixture data — no instance, no token needed |
| `npm test` | 268 unit tests (mappers, cache, client, actions, aggregator, hub, poller, webhooks, probes, metrics, auth, setup, static) |
| `npm run typecheck` | Both TypeScript projects |
| `npm run build` | Type-check, bundle the SPA into `dist/` and the BFF into `dist-server/` |
| `npm start` | Run the built server, which then serves the built SPA too |

Without a `.env`, the BFF answers `503` and the SPA shows the error with the exact next
step. `npm run dev:mock` needs neither.

## Configuration

Two variables are required; everything else has a working default. The full reference,
with what each knob costs and why the defaults are what they are, is in
**[docs/configuration.md](docs/configuration.md)** — and every variable is documented
inline in [`.env.example`](.env.example).

| Variable | Default | What it is |
|---|---|---|
| `COOLIFY_URL` | — | Instance root, without `/api/v1` |
| `COOLIFY_TOKEN` | — | API token; abilities decide what works (see below) |
| `DASHBOARD_PASSWORD` | *(empty)* | The dashboard's own password. Empty leaves every route open — set it before exposing it |
| `BFF_PORT` / `BFF_HOST` | `8787` / `127.0.0.1` | Where the server listens (the container sets `0.0.0.0`) |
| `DATA_DIR` | `./data` | SQLite file: KPI history and uptime samples |
| `WEBHOOK_SECRET` | *(empty)* | Enables `/app/hooks/coolify`; empty means polling only |
| `PROBES_ENABLED` | `true` | Uptime, latency and TLS expiry measurement |
| `METRICS_SSH_KEY` | *(empty)* | Setting it turns on the Sentinel CPU/RAM collector |

Token abilities map directly to what the UI can do: `read` for everything on screen,
`read:sensitive` for deployment logs and the Sentinel token, `deploy` for
deploy/cancel/restart/stop, `write` for the auto-deploy toggle and running a task. Missing
ones surface as a toast naming what to add — nothing breaks silently.

## Security

Read this before you put it on a public domain.

- **Set `DASHBOARD_PASSWORD` before giving it a domain.** The dashboard then asks for it
  once and keeps a signed session cookie; ten wrong guesses shut the door for five minutes.
  Leave it empty and every route stays open — anyone who can reach the port can deploy, stop
  applications and read build logs — which is why the container publishes on `127.0.0.1` by
  default. For per-user access or MFA, put an SSO proxy in front instead of using the
  password ([docs/deployment.md](docs/deployment.md#putting-an-authenticating-proxy-in-front-of-it-instead)).
- **The Coolify token never reaches the browser.** It lives in the BFF process only, which
  is the reason the BFF exists.
- **Coolify's outgoing webhooks are unsigned** — no HMAC, no timestamp, no delivery id. The
  authentication for `/app/hooks/coolify` is therefore a secret in the URL, compared in
  constant time. Without `WEBHOOK_SECRET` the route answers `503` instead of trusting
  anyone.
- **Give the token the least it needs.** A read-only token still renders the entire
  dashboard; actions simply report the missing ability.
- **The optional SSH key is only ever used to read Sentinel.** Prefer a dedicated key, and
  see [SECURITY.md](SECURITY.md) for the full threat model and how to report an issue.

## What is real, and what is an em dash

Every number on screen comes from somewhere, and the ones that cannot are shown as `—`
with the reason on hover rather than invented:

| On screen | Source |
|---|---|
| Applications, servers, environments, deployments, schedule, backups | Coolify REST API |
| Deployment logs | Coolify API, needs `read:sensitive` |
| Uptime %, response latency, server ping, certificate expiry | **Measured by the BFF**, stored in SQLite |
| CPU / MEM gauges | Sentinel over SSH, when `METRICS_SSH_KEY` is set — `—` with a reason otherwise |
| Disk gauge | Only the `high_disk_usage` webhook carries the percentage; it expires after 6 h rather than going stale |
| Hardware totals, edge traffic strip | Nothing in Coolify core provides them — [roadmap](docs/roadmap.md) |

Two KPIs from the original design had no source and were **replaced rather than faked**:
P95 response time became *median deployment duration*, and monthly cost became
*backups in the last 24 h*.

## Documentation

| Document | What it covers |
|---|---|
| [docs/coolify-setup.md](docs/coolify-setup.md) | Preparing the instance: API, tokens, abilities, allowlist, webhook, Sentinel |
| [docs/configuration.md](docs/configuration.md) | Every environment variable, its default and its cost |
| [docs/deployment.md](docs/deployment.md) | Docker, deploying on Coolify itself, proxies, SSE, backups, upgrades |
| [docs/architecture.md](docs/architecture.md) | How the BFF is built and why each decision went that way |
| [docs/api.md](docs/api.md) | The `/app/*` HTTP contract and the SSE event stream |
| [docs/coolify-api-notes.md](docs/coolify-api-notes.md) | Traps verified in Coolify's source — useful to anyone writing against its API |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptom → cause → fix |
| [docs/development.md](docs/development.md) | Local setup, layout, tests, conventions |
| [docs/roadmap.md](docs/roadmap.md) | What is done, what is next, and the rate-limit budget |

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
workflow, the test expectations and the conventions this codebase follows (comments explain
*why*, not *what*; anything the API cannot provide is shown as `—`, never estimated).

This project is not affiliated with Coolify. It talks to Coolify v4's public REST API and
was built against the v4.3.x source.

## License

[MIT](LICENSE) © thib-crypt
