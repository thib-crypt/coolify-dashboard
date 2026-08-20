# Notes on the Coolify API

Everything here was verified against the Coolify v4.3.x source (`routes/api.php` and the
controllers behind it) and against a running v4.3.2 instance, not against the OpenAPI
document — which has known drift. Published because most of it costs a day to rediscover.

Written from the outside, with gratitude: none of this is a complaint about Coolify, which
is doing something much harder than reading it.

## Authentication and errors

- **An invalid token returns `400 "Invalid token."`, not `401`.** Anything that classifies
  upstream errors by status alone will call this a bad request.
- **`403` covers four different problems**: missing ability on the token, insufficient role
  in the team, the API being disabled instance-wide, and the caller's IP not being in the
  allowlist. Only the message distinguishes them, and the difference matters to whoever has
  to fix it.
- **Elevated abilities also require an elevated role.** A token with `deploy` created by a
  team *member* is refused (`EnsureTokenBelongsToCurrentTeamMember`); it must belong to an
  admin or owner.
- **The rate limit is per user**, not per token: `API_RATE_LIMIT`, 200 req/min by default,
  shared across everything that user's tokens do.
- **Writes need both `Content-Type: application/json` and a non-empty JSON body.** A `POST`
  with neither is rejected with a `400` that does not say so.
- **`serializeApiResponse` reorders keys.** Never depend on property order.

## Shapes that surprise

- **`GET /api/v1/version` answers in plain text.** So does `/api/health`. Calling
  `res.json()` on either throws.
- **A deployment's `logs` is a JSON *string*, not an array.** Parse it, sort by `order`,
  drop `hidden`, and keep `type ∈ stdout|stderr`. Secrets are already redacted upstream.
  It is only present with `read:sensitive` **and** an admin/owner role.
- **`GET /deployments` returns only `queued` and `in_progress`.** History is per
  application: `GET /deployments/applications/{uuid}?skip&take`, whose response shape the
  OpenAPI document gets wrong.
- **There is no `started_at` on a deployment.** Duration is `finished_at − created_at`,
  which includes queue time.
- **`finished_at` sometimes arrives as `2026-08-17 12:02:06`, with no timezone**, while
  Coolify stores UTC. Parsed as local time, every duration in the UI shifts by your offset.
- **`GET /applications` hides `id` and omits `settings`.** So the auto-deploy state needs
  `GET /applications/{uuid}` per application, and deployments can only be matched back to
  their application by `application_name`.
- **`status` is a compound string**, `"running:healthy"` — state and health in one field,
  and the health half can be absent.

## Actions

- **`start` / `stop` / `restart` are `POST`.** The documentation says `GET`; current
  instances answer `405 "This endpoint has changed to a POST request."` The safe move is
  POST first, one GET fallback for older instances, and remember which verb worked.
- **`200` does not mean it happened.** A deploy that was skipped (*"Deployment already
  queued for this commit."*) and one that was refused (*"Unauthorized to deploy this
  application."*) both come back `200` alongside genuine successes. Only the message tells
  them apart.
- **Worse: a skipped deploy still returns a `deployment_uuid`** — a freshly generated id
  matching no deployment that exists. Trusting it means polling forever for a build that
  will never appear.
- **A full deployment queue and the rate limiter both answer `429`.** Again, the message is
  the only difference; the first clears as builds finish, the second needs you to slow down.
- **Cancelling only works on `queued` / `in_progress`.** Anything else is a `400`.
- **Auto-deploy is `PATCH /applications/{uuid}` with `is_auto_deploy_enabled`.**

## Real time

- **There is no usable real-time channel from outside.** `POST /broadcasting/auth` (the
  Soketi channel authentication) sits behind the `web` middleware — session plus CSRF, not
  Bearer — and outside the CORS paths. And no deployment-progress event is broadcast anyway;
  Coolify's own UI polls with Livewire every 2 s.
- **Outgoing webhooks are not signed.** No HMAC, no timestamp, no delivery id. A secret in
  the URL is the only authentication available to a receiver.
- **Coolify retries a delivery five times** with a 10 s backoff, and a retry is byte-identical
  to a new event. Receivers need their own idempotency key — `deployment_uuid` plus event
  name works.
- **`SafeWebhookUrl` refuses loopback, link-local and private webhook URLs** unless the
  operator allowlisted them. A receiver on `localhost` will never be called.
- **No event announces the *start* of a deployment.** The twenty outgoing events cover
  success, failure, status changes, backups, tasks and server reachability — never a build
  beginning. Seeing a deployment start can only come from polling.
- **Only the `high_disk_usage` webhook carries a disk percentage.** `GET /servers` exposes
  `high_disk_usage_notification_sent`, which says an alert *exists*, not how full the disk
  is.

## Sentinel, CPU and RAM

- **There is no REST endpoint for CPU or memory series.** Coolify's own charts use
  `app/Traits/HasMetrics.php`, which SSHes into the server and runs
  `docker exec coolify-sentinel curl http://localhost:8888/api/{cpu,memory}/history`.
- **The API exposes only Sentinel's configuration** (`GET/PATCH /servers/{uuid}/sentinel`).
  `POST /api/v1/sentinel/push` is the agent announcing its *containers* to Coolify, not its
  measurements.
- **`sentinel_token` is absent — not empty — without `read:sensitive`.** Code that checks for
  an empty string will read the wrong situation.
- **Validate that token before interpolating it** into the remote command:
  `/\A[a-zA-Z0-9._\-+=\/]+\z/`, the same class Coolify enforces in
  `ServerSetting::isValidSentinelToken`.
- **`sentinel_updated_at` is not in `GET /servers`** — that list `select()`s a short column
  set. But `settings.is_metrics_enabled` *is* there, which is enough to know whether asking
  is worthwhile. The heartbeat itself comes from `GET /servers/{uuid}/sentinel`.
- **Sentinel timestamps are epoch seconds**, and the value field differs per metric:
  `percent` for CPU, `usedPercent` for a server's memory (a *container* reports raw bytes in
  `used`).
- **A Sentinel error arrives as `{"error": "..."}` with a `200` from `curl`.** Inspect the
  body, not the status. `Unauthorized` means the token was regenerated and the Sentinel
  container needs restarting to pick up the new one.

## Things that are simply absent

Not bugs — just boundaries worth knowing before designing a UI against them:

| Wanted | Reality |
|---|---|
| Application uptime | Not tracked. Measure it yourself. |
| HTTP latency / P95 | Not tracked. Traefik's Prometheus metrics can be enabled per server and scraped. |
| Server CPU / RAM over REST | Sentinel over SSH only (above). |
| Hardware totals (vCPU, RAM, disk) | Not exposed. |
| Edge traffic | Nothing in Coolify core. |
| Plugin or extension points | None. The UI is a Livewire monolith; the integration surfaces are the REST API, the read-only MCP server and outgoing webhooks. |

That last row is the reason this project is a companion app rather than a plugin.

## Related

- [`shared/coolify-api.ts`](../shared/coolify-api.ts) — the hand-written types these notes
  produced.
- [`server/coolify/client.ts`](../server/coolify/client.ts) — error classification and the
  verb fallback.
- [`server/coolify/mappers.ts`](../server/coolify/mappers.ts) — the parsing, with tests
  covering each trap above.
