# The `/app/*` API

Everything the browser talks to. There is no other surface: the SPA never calls Coolify,
so these shapes are the whole contract. They are typed in
[`shared/bff.ts`](../shared/bff.ts), which the front end and the server both import — if
this page and that file ever disagree, the file is right.

All responses are JSON unless stated otherwise. Errors share one envelope:

```json
{ "error": { "code": "forbidden",
             "message": "The token is missing the `deploy` ability.",
             "hint": "Create a token in Coolify (Security → API Tokens) with …",
             "retryAfterSeconds": 60 } }
```

| `code` | HTTP | Means |
|---|---|---|
| `not_configured` | 503 | `COOLIFY_URL` / `COOLIFY_TOKEN` missing, or the route needs a secret that is not set |
| `unauthorized` | 502 | Coolify rejected the token (it answers **400 `Invalid token.`**, translated here) |
| `forbidden` | 502 | Missing ability, insufficient team role, API disabled, or IP not allowlisted — the `hint` says which |
| `not_found` | 404 | Deleted, or owned by another team |
| `invalid_state` | 409 | The action does not apply — cancelling a finished deployment, for instance |
| `queue_full` | 429 | Coolify's deployment queue is full; `retryAfterSeconds` is set |
| `rate_limited` | 429 | Coolify's 200 req/min limit |
| `upstream_unreachable` | 504 | The instance did not answer |
| `upstream_error` | 502 | Anything else Coolify returned |
| `internal` | 400 / 500 | Malformed request, or a bug here |

## Reads

### `GET /app/health`

Whether every moving part is working, and what it cannot do. `200` when Coolify answers,
`502` when it does not, `503` when the BFF has no configuration at all — the body is the
same shape in all three cases, so a monitor can read it rather than guess from the status.

```json
{
  "ok": true,
  "service": "coolify-dashboard-bff",
  "now": "2026-08-20T10:01:04.599Z",
  "coolify": { "configured": true, "url": "https://coolify.example.com", "version": "v4.3.2" },
  "notes": [{ "scope": "metrics", "reason": "No SSH key, so CPU and RAM stay unknown." }],
  "live":    { "subscribers": 1, "poller": "active", "webhooks": "ready",
               "lastWebhookAt": "2026-08-19T09:50:11.276Z" },
  "probes":  { "enabled": true, "applications": 2, "servers": 1,
               "intervalMs": 60000, "lastRunAt": "2026-08-19T10:31:48.561Z" },
  "metrics": { "enabled": true, "servers": 2, "reporting": 1,
               "intervalMs": 30000, "lastRunAt": "2026-08-20T10:01:04.599Z" }
}
```

`metrics.reporting` is the one to watch: it counts servers that actually returned numbers,
as opposed to servers the collector merely tried.

**Container health checks should not treat `ok: false` as a reason to restart.** It means
Coolify is unreachable or unconfigured, which restarting will not fix; the process
answering at all is the real signal.

### `GET /app/overview?env=<name>`

The entire dashboard in one payload — roughly ten Coolify endpoints aggregated, cached per
family, and mapped into a single `Dashboard` object. `env` is optional and filters by
environment name; omitting it uses the first one.

```json
{
  "generatedAt": "2026-08-20T10:01:04.599Z",
  "staleAfterMs": 5000,
  "dashboard": {
    "org": "Acme", "environment": "production", "environments": ["production", "staging"],
    "systemStatus": { "ok": true, "label": "All systems operational" },
    "kpis": [], "deployments": [], "deploymentCount": 0,
    "servers": [], "fleetTotals": {}, "insights": [],
    "applications": [], "applicationCount": 0,
    "timeline": {}, "paletteActions": []
  },
  "notes": [{ "scope": "traffic", "reason": "Coolify core exposes no edge metrics." }]
}
```

- `staleAfterMs` is the shortest cache TTL in play — how long the SPA may reuse this payload
  before asking again.
- `notes` is how the dashboard stays honest: one entry per thing it is rendering without a
  real source behind it. The UI turns them into the `—` tooltips.
- The response is `Cache-Control: private, no-store`, deliberately. The SPA refetches
  *because* a push said the data moved; a browser cache would answer that refetch from the
  copy the push just invalidated.

### `GET /app/events` (SSE)

One `text/event-stream` per tab. Every frame is an unnamed `message` whose `data` is one
JSON object, so the client needs a single listener. A `: keepalive` comment goes out every
25 s, because proxies drop idle streams long before that. At most 64 concurrent streams;
past that the endpoint answers `503` and the dashboard falls back to fetching.

| `type` | Payload | When |
|---|---|---|
| `hello` | `at`, `notes[]` | First frame. `notes` says what this channel *cannot* deliver — webhooks disabled, for instance. |
| `overview-changed` | `at`, `reason` | Something moved upstream: refetch `/app/overview`. The SPA coalesces these at 250 ms. |
| `deployment-log` | `at`, `deploymentId`, `from`, `lines[]` | New build output. `from` is the absolute index of `lines[0]`, so a replayed or duplicated frame is harmless. |
| `deployment-finished` | `at`, `deploymentId`, `app`, `state`, `message` | A build ended. `state` is never `running`. |
| `toast` | `at`, `message`, `tone` | Something worth interrupting for: server down, backup failed. `tone` is `info` / `ok` / `warn` / `err`. |

Two sources feed this — the adaptive poller and Coolify's webhooks — and they overlap on
purpose. The hub deduplicates by key, so the end of a deployment is announced once, by
whichever saw it first.

## Writes

Each one answers with an `ActionResponse`:

```json
{ "outcome": "queued", "message": "Deployment queued.", "deploymentUuid": "abc123" }
```

`outcome` is the part that matters, because **Coolify answers `200` even when it did
nothing**:

| `outcome` | Means |
|---|---|
| `queued` | A deployment was created; `deploymentUuid` identifies it |
| `done` | Applied immediately — stop, auto-deploy toggle, task run |
| `skipped` | Accepted and ignored: same commit already queued, or the caller is not allowed to deploy this application. The dashboard does not celebrate a non-event. |

`message` is Coolify's own wording, safe to put straight in a toast.

| Route | Body | Upstream |
|---|---|---|
| `POST /app/deploy` | `{ "uuid": "…", "force": false }` | `POST /api/v1/deploy` |
| `POST /app/deployments/:uuid/cancel` | — | `POST /api/v1/deployments/{uuid}/cancel` |
| `POST /app/applications/:uuid/autodeploy` | `{ "enabled": true }` | `PATCH /api/v1/applications/{uuid}` |
| `POST /app/applications/:uuid/start\|restart\|stop` | — | the matching Coolify action |
| `POST /app/applications\|services/:uuid/tasks/:task/run` | — | `POST …/scheduled-tasks/{task}/execute` |

Every write invalidates the cache entries its read counterpart filled — deployments after a
deploy, the application detail after a toggle — so the effect of a click is visible on the
next refetch instead of up to five minutes later.

## `POST /app/hooks/coolify?secret=…`

Where Coolify's outgoing webhooks land. Returns `202` with
`{ "ok": true, "accepted": true, "event": "deployment_success" }`.

- **`503` until `WEBHOOK_SECRET` is set.** The payloads are unsigned, so accepting them
  without a secret would let anyone forge a toast.
- **`403` on a bad secret**, compared in constant time (SHA-256 of both sides, so a length
  difference neither throws nor leaks).
- **`accepted: false` means "already handled".** Coolify retries a delivery up to five times
  with a 10 s backoff, and a retry is byte-identical to a new event; each announcement
  carries a dedupe key valid for two minutes. A retry must stay completely invisible —
  otherwise five deliveries would cost five `/app/overview` refetches in every open tab.
- **Always answers 2xx on an authenticated payload.** A non-2xx is what makes Coolify retry.

Anything else under `/app/*` is a JSON `404`. Everything *not* under `/app/*` is the SPA
(when a build is present), including deep links, so a browser reload never 404s.
