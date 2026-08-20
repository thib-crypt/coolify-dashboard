# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [semantic versioning](https://semver.org/) from 1.0.0 onwards.

## [1.0.0] — 2026-08-20

First release. Phases 0–6 are done, and phase 7 is done except for two data sources Coolify
itself does not expose (see [docs/roadmap.md](docs/roadmap.md)). What landed since the five
phases below:

### Added

- **Pages behind the rail.** `react-router`, with `/applications`, `/applications/:uuid`,
  `/deployments`, `/servers`, `/schedule` and `/setup`; a layout route holds the one live
  channel, so a page change costs no upstream requests and the SSE stream survives it. Every
  panel's *View all* now goes somewhere, and a deep link into any of them survives a reload.
- **An application page**, with everything the overview has no room for: runtime logs
  (`GET /app/applications/:uuid/logs`), environment variables, its own deployment history,
  and **rollback** to an image already built on the server
  (`POST /app/applications/:uuid/rollback`). A stopped container answers with an empty log
  and the reason rather than an error, a variable the token may not read is labelled as
  withheld rather than masked, and the running image is never offered as a rollback target.
- **The full deployment history**, at `GET /app/deployments?env&skip&take&app` — assembled
  from each application's own history, because Coolify's `/deployments` returns only what is
  queued or running.

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

### Fixed

- **A full deployment queue is recognised on a rollback.** Coolify answers `429` for a
  deploy and `400` for a rollback with the same sentence underneath; both are now
  `queue_full` — the one 4xx that means "just try again in a minute" — instead of the
  rollback surfacing as a generic invalid state.

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

[1.0.0]: https://github.com/thib-crypt/coolify-dashboard/releases/tag/v1.0.0
