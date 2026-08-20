# Troubleshooting

Start here:

```bash
curl -s http://127.0.0.1:8787/app/health | jq
```

That one payload says whether the BFF is configured, whether Coolify answers, whether the
live channel is connected, and whether the probes and the metrics collector are running.
Most of the answers below are a field in it.

## Nothing loads

**`503` with `Missing COOLIFY_URL and COOLIFY_TOKEN`** — no configuration. Copy
`.env.example` to `.env` and fill both in, or pass them as environment variables. The SPA
shows this error verbatim, with the next step.

**`Invalid token.`** — Coolify returns **400** for a bad token, not 401. It was mistyped,
revoked, or belongs to a deleted user. Check it directly:

```bash
curl -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/version"
```

**`forbidden`** — four different causes, and the `hint` field says which:

| Hint mentions | Fix |
|---|---|
| `Settings → Advanced → API Access` | The API is disabled instance-wide |
| the allowlist | Add the dashboard host's IP under `Settings → Advanced` |
| an ability | Recreate the token with `read` (and `read:sensitive` for logs) |
| admin or owner | The token's owner is only a *member* of the team; elevated abilities need admin/owner |

**`upstream_unreachable`** — `COOLIFY_URL` is wrong, or the instance is down. It must be the
root (`https://coolify.example.com`), not `…/api/v1`, though a trailing `/api/v1` is
stripped for you.

## The dashboard loads, but a number is missing

Every `—` has a reason on hover and an entry in `notes` on `/app/overview`. The common ones:

**CPU / MEM gauges empty.** Expected on a default install: Coolify has no REST endpoint for
them. The tooltip says which of four situations you are in — no collector configured
(`METRICS_SSH_KEY` unset), Sentinel disabled on that server, a reading gone stale, or the
collector failing. For the last one, `metrics.reporting` in `/app/health` counts the servers
actually returning numbers, and the tooltip carries `ssh`'s own error output. See
[coolify-setup.md](coolify-setup.md#5-optional--cpu-and-ram-gauges-sentinel).

**DSK gauge empty.** Only Coolify's `high_disk_usage` webhook carries a disk percentage —
no REST route exposes it. Configure the webhook and the gauge fills the next time the alert
fires; the reading expires after 6 h rather than going stale.

**Uptime, latency or certificate expiry showing `—`.** Either `PROBES_ENABLED=false`, or the
application has no public domain, or it is excluded by `PROBE_APPS`, or there are fewer than
**5 samples** so far — five minutes after a restart, percentages start appearing.
`probes.applications` in `/app/health` is how many targets the loop actually found.

**The deployment log ticker stays empty.** `logs` requires `read:sensitive` **and** an
admin/owner role on the token's owner. Both, not either.

## Live updates feel slow or absent

**Check `live.subscribers` in `/app/health` while a tab is open.** If it is `0`, the SSE
stream is not getting through — almost always a proxy that buffers responses. See the Nginx
snippet in [deployment.md](deployment.md#behind-your-own-reverse-proxy). Nothing is broken
in this state: the SPA falls back to fetching every 10 s.

**`live.webhooks` says `disabled`.** `WEBHOOK_SECRET` is not set, so `/app/hooks/coolify`
answers `503` and everything arrives by polling instead — a few seconds later, never wrong.

**`lastWebhookAt` stays `null` although the webhook is configured.** Three usual causes:

- Coolify refuses loopback and private webhook URLs (`SafeWebhookUrl`) — it must be a
  publicly reachable address;
- the secret in the URL does not match `WEBHOOK_SECRET`, which shows up as a `403` and a
  `[hooks] rejected a payload` line in the logs;
- the events themselves are not enabled in the `PATCH /notifications/webhook` payload.

**A deployment started from Coolify's UI takes a few seconds to appear.** By design, and it
cannot be better: no Coolify webhook announces the *start* of a build, so `POLL_IDLE_MS`
(4 s) is the detection latency. Lower it if you want, at a proportional upstream cost.

## Actions do not do what I expect

**The toast says the deploy was skipped.** Coolify accepted the call and did nothing — most
often *"Deployment already queued for this commit."* It answers `200` for that, same as for
a real deployment, so the dashboard reports `skipped` rather than celebrating a non-event.
Use *force* (rebuild without cache) if you meant to redeploy the same commit.

**`queue_full` (429).** Coolify's deployment queue for that server is full. It clears as
builds finish; `Retry-After` says when to try again.

**`rate_limited` (429).** Coolify's 200 req/min, counted **per user** across all of that
user's tokens. If you script against the same account, give the dashboard its own machine
user.

**`invalid_state` (409) on cancel.** The deployment already finished. Coolify only cancels
`queued` and `in_progress` builds.

## Operational

**History resets on every restart.** Either `DATA_DIR` is not on a persistent volume, or
`node:sqlite` is unavailable in your runtime and the store fell back to an in-memory ring
buffer. `store` is reported at startup: `snapshots: sqlite` or `snapshots: memory`. Node 24+
has SQLite built in.

**The container is `unhealthy`.** The health check only asks whether the BFF answers, so an
unreachable Coolify does not cause it. An actual failure means the process is not listening:
check `docker logs`, and that `BFF_PORT` inside the container matches what the check probes.

**`EADDRINUSE` on 8787.** Something else has the port — often a previous `npm run dev`.
`BFF_PORT` moves it, and `PORT` is honoured too if `BFF_PORT` is unset.

**The SPA is served but `/app/*` returns HTML.** The static handler is mounted after the API
routes precisely so this cannot happen; if you see it, an API route was added *after*
`mountStatic` in `server/index.ts`.

## Still stuck

Open an issue with the output of `/app/health` (redact `coolify.url` if you like), your
Coolify version, and what you expected to see —
[github.com/thib-crypt/coolify-dashboard/issues](https://github.com/thib-crypt/coolify-dashboard/issues).
