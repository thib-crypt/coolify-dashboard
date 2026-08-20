# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [semantic versioning](https://semver.org/) from 1.0.0 onwards.

## [Unreleased]

### Added

- **A password on the dashboard itself.** `DASHBOARD_PASSWORD` is exchanged once at
  `POST /app/session` for an `HttpOnly`, `SameSite=Lax` cookie carrying a signed expiry —
  no server-side session store, so a restart signs nobody out. Ten failed attempts shut the
  door for five minutes. Unset, every route stays open exactly as before: an upgrade cannot
  lock anyone out of their own dashboard.

- **A Coolify service template**, `templates/coolify/coolify-dashboard.yaml`: pasted into a
  Docker Compose Empty resource, Coolify generates the domain, the dashboard password and the
  webhook secret, and asks only for the instance URL and an API token.
- **A first-run setup check**, at `GET /app/setup` and behind every failure-to-load screen.
  It separates the four problems Coolify reports identically — revoked token, missing
  ability, member-level owner, blocked IP — and links to the page that fixes each. Every
  probe is a read: `deploy` and `write` are tested on the GET twin of each action route,
  which answers `405` behind the same ability middleware.
- **Published container images.** `ghcr.io/thib-crypt/coolify-dashboard`, built by CI for
  `linux/amd64` and `linux/arm64`, tagged per release plus `:edge` for `main`, each with a
  signed build provenance attestation. `docker-compose.yml` now pulls the image instead of
  building it.
- **Packaging.** Multi-stage `Dockerfile` and `docker-compose.yml`: one container that
  serves the built SPA and the API, running as a non-root user, with a health check and a
  volume for the SQLite history.
- **The BFF serves the built SPA** in production (`STATIC_DIR`), with immutable caching for
  fingerprinted assets and a fallback so deep links survive a reload.
- **`BFF_HOST`**, defaulting to `127.0.0.1`; the container binds `0.0.0.0`.
- **Documentation**, in English: setup, configuration, deployment, architecture, the
  `/app/*` API, verified Coolify API notes, troubleshooting, development and the roadmap.

### Changed

- `npm run build` now type-checks and builds both halves; `npm start` runs the built server.

## Earlier work

Before this changelog existed, in five phases — each one documented with what was decided
and what was rejected in [docs/roadmap.md](docs/roadmap.md):

- **Phase 5 — Server metrics.** Sentinel over SSH behind `METRICS_SSH_KEY`, one connection
  per server per cycle; without a key, gauges that say *which* silence they are.
- **Phase 4 — Uptime and insights.** HTTP, TLS and TCP probes on one loop, every result
  stored in SQLite; a pure-function rule engine whose findings deep-link into Coolify.
- **Phase 3 — Real time.** SSE, an adaptive poller that stops when no tab is open, and
  incoming webhooks deduplicated against it. A deployment started elsewhere appears in 3.6 s.
- **Phase 2 — Actions.** Deploy, cancel, restart, stop, auto-deploy, scheduled tasks —
  with explicit `queued` / `done` / `skipped` outcomes, because Coolify answers `200` even
  when it did nothing.
- **Phase 1 — Live data.** The `/app/overview` aggregator, per-family TTL caching with
  single-flight, pure mappers, and hourly SQLite snapshots for the KPI deltas.
