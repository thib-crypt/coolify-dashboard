# Roadmap

Where the project is, what was decided along the way, and what is left. Phases 0–5 are
done; the two that remain are the ones that turn a working dashboard into a product.

The analysis this plan rests on was done against the Coolify **v4.3.9** source and its
docs, targeting a **v4.3.2** instance. The API traps it turned up live in
[coolify-api-notes.md](coolify-api-notes.md).

| Phase | What it delivers | Status |
|---|---|---|
| 0 | Light monorepo: `shared/`, `server/`, dev scripts | ✅ Done |
| 1 | Read-only: the dashboard shows the real instance | ✅ Done |
| 2 | Actions: deploy, cancel, restart/stop, toggles, tasks | ✅ Done |
| 3 | Real time: SSE, adaptive poller, incoming webhooks | ✅ Done |
| 4 | Measured uptime, latency, TLS expiry, insight engine | ✅ Done |
| 5 | Server metrics through Sentinel over SSH | ✅ Done |
| 6 | Navigation and per-resource pages | ⬜ Next |
| 7 | Packaging, authentication, one-click install | 🟨 Partly done |

## The framing decision

**Coolify has no plugin system.** The UI is a Livewire monolith — `routes/web.php` maps
straight onto components, with no hooks and no slots. The official integration surfaces are
the REST API, the read-only MCP server, and outgoing webhooks.

So the durable shape for this is a **companion application**: a standalone container you
deploy next to Coolify (or on it), configured with two environment variables, talking to the
API. Forking or patching Coolify is reserved for targeted upstream contributions — see
[phase 5](#phase-5--server-metrics-sentinel) for the one this project would like to make.

## Done

### Phase 1 — Read-only

`GET /app/overview` aggregates roughly ten Coolify endpoints into one `Dashboard`, behind a
per-family TTL cache with single-flight coalescing and a stale-value fallback. Mappers are
pure functions, so every parsing trap is unit-tested without a network. Hourly SQLite
snapshots give the KPI deltas and sparklines that Coolify keeps no history for.

### Phase 2 — Actions

Deploy, cancel, restart, stop, auto-deploy toggle, run a scheduled task — all through the
BFF, which translates intents into Coolify calls, reads what Coolify *actually* did, and
purges the cache entries the write invalidated.

The finding that shaped it: **Coolify answers `200` even when it did nothing**, and a
skipped deploy even returns a `deployment_uuid` matching no deployment. Hence the explicit
`queued` / `done` / `skipped` outcome, and a dashboard that does not celebrate a
non-event. `start` / `stop` / `restart` go out as POST with a memoised GET fallback for
older instances, because the documented verb is wrong.

### Phase 3 — Real time

SSE on `/app/events`, fed by an adaptive poller and by incoming webhooks, deduplicated
against each other. Three deviations from the original plan, all measured:

- **One poller, not two.** `/deployments` already carries `logs` when the token has
  `read:sensitive`, so polling each running deployment as well would have doubled the cost
  and learned nothing.
- **4 s at idle, not 15 s.** No webhook announces the *start* of a build, so this cadence is
  the detection latency for a deployment launched from Coolify's own UI. 15 s missed the
  "under 5 s" target. Measured end to end: **3.6 s**.
- **The poller stops when the last tab closes**, which is what pays for that cadence.

### Phase 4 — Uptime and insights

Three outbound probes on one loop: HTTP per public domain (60 s), a TLS handshake per https
domain (1 h), a TCP ping per server (60 s). Every HTTP result is a SQLite row, so the
percentage is a measurement that survives a restart. Deviations:

- **The loop does not stop when nobody is watching**, unlike the poller — an uptime measured
  only while someone is looking is not an uptime. It costs nothing upstream: these requests
  go to your applications, not to Coolify.
- **Three consecutive failures before declaring an outage, five samples before showing a
  percentage.** A timeout is a hiccup; "100 %" from a single measurement says nothing.
- **The disk gauge does not come from a probe.** `high_disk_usage_notification_sent` says an
  alert *exists*; only the webhook carries the percentage, kept for 6 h and then expired
  rather than shown stale.

The insight engine is a set of pure rules over the measured state, sorted by severity,
deduplicated, each one deep-linking to the Coolify page where the problem gets fixed. When
there are more findings than room, the last row counts what it is hiding.

### Phase 5 — Server metrics (Sentinel)

Coolify has no REST endpoint for CPU or RAM: its own charts SSH in and query the Sentinel
agent. Of the three options, the two that can live in this repo are implemented, and the SSH
key is the switch between them:

| `METRICS_SSH_KEY` | Fleet gauges show | Upstream cost |
|---|---|---|
| empty (default) | `—` with the reason on hover | **zero requests** |
| set | Real percentages read from Sentinel | ~0.2 req/min per server |

**The third option is an upstream contribution, and it is not done.** The `HasMetrics` trait
already does the work; what is missing in Coolify is an API controller calling it with the
same guards as `ServerSentinelController` (`api.ability:read` + `read:sensitive`,
`authorize('view', $server)`, `Server::isMetricsEnabled()`). A route like
`GET /api/v1/servers/{uuid}/metrics?minutes=5` would make this repo's SSH collector
unnecessary — for this dashboard and for everyone else building against Coolify. It is a
patch on Coolify, not on this repository, which is why it is listed here rather than shipped.

## Next

### Phase 6 — Navigation and pages

Today the rail does not navigate: there is one page, and `aria-current` stays on Overview.
This is the first real addition.

- `react-router`, with `/`, `/applications`, `/applications/:uuid`, `/deployments`,
  `/servers/:uuid`, `/schedule`; the rail's active state is already styled.
- An application page: runtime logs (`GET /applications/{uuid}/logs`, which `400`s when the
  container is stopped), environment variables (masked without `read:sensitive`), paginated
  deployment history, and rollback (`GET …/rollback-images` + `POST …/rollback`).
- The environment selector becomes a real cross-cutting filter, mapped from `environment_id`.

### Phase 7 — Packaging and plugability

Partly done — the container exists and is documented in
[deployment.md](deployment.md). What remains is what makes it safe and pleasant to install:

- **Authentication.** `DASHBOARD_PASSWORD` and a signed session cookie, so the dashboard can
  face a domain without an external proxy in front of it. This is the most important item
  on this list: today the answer is "put a proxy in front", and that is a real gap rather
  than a design choice.
- **Published images.** `ghcr.io/thib-crypt/coolify-dashboard`, built by CI, tagged per
  release, so deploying does not mean building.
- **A guided `/setup` page** on first run: test the token against `/api/v1/version` and
  `/api/v1/team`, check each ability, and list precisely what is missing.
- **A Coolify service template** (`templates/compose/` upstream) for a genuine one-click
  install from Coolify's own UI — the most "plugable" this architecture allows today.
- **Edge traffic and a real P95**, by enabling Traefik's Prometheus metrics
  (`PUT /api/v1/servers/{uuid}/proxy/configuration`) and scraping them. That would give the
  traffic strip a source and turn the median-deployment-duration KPI back into a response-time
  one.
- **Hardware totals** (vCPU, RAM, storage) for the fourth Fleet tile, from the Hetzner
  endpoints (`/api/v1/hetzner/*`) when the servers are Hetzner ones.

## Appendix A — What the instance needs

Moved to its own page: [coolify-setup.md](coolify-setup.md). Short version — enable the API,
allowlist the dashboard's IP, create a token from an admin/owner account, and optionally
configure the outgoing webhook and Sentinel.

## Appendix B — The rate-limit budget

Coolify allows 200 req/min **per user**. Measured cadences, against the original estimate:

| Source | Idle | Active | req/min max | Planned |
|---|---|---|---|---|
| `/deployments` (running **+ logs**) | 4 s | 2.5 s | 24 | 20 |
| ~~`/deployments/{uuid}` for live logs~~ | — | — | 0 | 24 |
| `/deployments/{uuid}` for a terminal status | — | 1 per finish | ~1 | — |
| `/applications` | 30 s | 30 s | 2 | 2 |
| `/servers` | 60 s | 60 s | 2 | 2–4 |
| Deployment history | 2 min | 2 min | ~3 | ~5 |
| Scheduled tasks + backups | 5 min | 5 min | ~3 | ~3 |
| Probe target list | 5 min | — | ~0.4 | — |
| Sentinel config per server (opt-in) | 5 min | 5 min | ~0.2 / server | — |
| **Total** | | | **under 36** ✅ | under 60 |

Three things make this hold:

- **The poller only runs while at least one browser is connected.** With no tab open, the
  only upstream traffic left is the probes' target list — about 0.4 req/min. That is the
  price of an uptime that keeps being measured overnight.
- **The probes themselves are outside this budget.** They query your applications, not
  Coolify.
- **The metrics collector is nearly outside it too.** All it reads from Coolify is each
  server's Sentinel configuration, which barely ever changes (5 min TTL). The measurements
  come over SSH from your own servers. With no `METRICS_SSH_KEY` this row is exactly zero.

One BFF serves N tabs on this constant budget. That is the decisive argument against letting
the browser call Coolify directly — the cost would multiply by the number of tabs, and the
`X-RateLimit-*` headers are not even readable cross-origin.

## Appendix C — UI ↔ Coolify data mapping

What each block of the interface actually reads. "BFF" means computed or stored here.

| UI block | Source |
|---|---|
| Organisation | `GET /team` → `name` |
| Environments | `GET /projects` then `/projects/{uuid}/environments`, cached long |
| System status | BFF: all servers reachable, no failed deployment in the last hour, no recent `server_unreachable` / `high_disk_usage` |
| KPI · applications | `GET /applications`, weekly delta from SQLite snapshots |
| KPI · deployments 24 h + success % | Per-application history, aggregated and persisted by the BFF |
| KPI · median deployment duration | `finished_at − created_at` over the history (replaces the design's P95, which has no source) |
| KPI · backups 24 h | `GET /databases` then `/databases/{uuid}/backups` + `executions` (replaces monthly cost) |
| Sparklines | Built from the BFF's own snapshots |
| Traffic strip | **No source in Coolify core** — Traefik metrics, phase 7 |
| Deployments in progress | `GET /deployments` (returns only `queued` + `in_progress`) |
| Deployment history | `GET /deployments/applications/{uuid}?skip&take` |
| Live build logs | The `logs` field, a JSON string, needs `read:sensitive` + admin role |
| Deploy / cancel | `POST /deploy`, `POST /deployments/{uuid}/cancel` |
| Fleet · servers | `GET /servers` (+ `/servers/{uuid}` for settings); `reachable` = `is_reachable` |
| Fleet · CPU / MEM | Sentinel over SSH (phase 5), or a reasoned `—` |
| Fleet · DSK | `high_disk_usage` webhook; `—` otherwise |
| Fleet · ping | TCP probe from the BFF |
| Fleet · fourth tile | "Capacity —" with no collector, "Avg load" once Sentinel is read |
| Insights | BFF rule engine over the measured state |
| Applications | `GET /applications`; uptime from the BFF's probes; auto-deploy from `PATCH /applications/{uuid}` |
| Schedule | `GET /{applications,services}/{uuid}/scheduled-tasks` + backup frequencies, cron parsed by the BFF |
| ⌘K palette | Generated from the real resources |
