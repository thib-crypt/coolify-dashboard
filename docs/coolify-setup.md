# Preparing your Coolify instance

Five minutes, all of it inside Coolify. The dashboard needs an API it is allowed to call,
a token with the right abilities, and — optionally — a webhook and Sentinel.

Built and verified against **Coolify v4.3.x**.

## 1. Enable the API

`Settings → Advanced → API Access`.

On a self-hosted instance this is **off by default** (`is_api_enabled` is `false`). With it
off, every call comes back as a `403` and the dashboard says so on its first screen.

## 2. Allow the dashboard's IP

Same page: `Settings → Advanced → API allowed IPs`.

Add the public IP of the host running the dashboard. If the list is empty Coolify accepts
any source; if it is not, an address that is missing gets a `403` that looks exactly like a
permission problem. When the dashboard runs *on* the Coolify server itself, add that
server's own IP.

## 3. Create a token

`Security → API Tokens`. The value is shown **once** — copy it straight into your `.env`.

Two things decide what the token can do:

**Its abilities.** Tick them according to what you want the dashboard to be allowed to do:

| Ability | What it unlocks | Without it |
|---|---|---|
| `read` | Everything on screen: applications, servers, deployments, schedule, backups | Nothing loads |
| `read:sensitive` | Live deployment logs, and the Sentinel token needed for CPU/RAM | The log ticker stays empty; gauges say why |
| `deploy` | Deploy, cancel, restart, stop | Those actions toast "missing ability" |
| `write` | Auto-deploy toggle, running a scheduled task | Same |

A **read-only token renders the entire dashboard**. Actions then fail loudly and
individually instead of the app breaking — start there if you want to try it out.

**Its owner.** The token belongs to the team that was active when it was created, and
elevated abilities also require that account to be an **admin or owner** of that team
(`EnsureTokenBelongsToCurrentTeamMember`). A member-level account gets a systematic `403`
on `deploy` and `write` no matter which boxes were ticked.

> **Tip — protect your rate-limit budget.** Coolify's limit (`API_RATE_LIMIT`, 200 req/min
> by default) is counted **per user**, across all of that user's tokens. Creating the
> dashboard's token from a dedicated machine account keeps its traffic from competing with
> your own scripts. The dashboard itself stays under 36 req/min — see
> [roadmap.md](roadmap.md#appendix-b--the-rate-limit-budget).

Then fill in your `.env`:

```bash
COOLIFY_URL=https://coolify.example.com   # no /api/v1, no trailing slash
COOLIFY_TOKEN=1|xxxxxxxxxxxxxxxxxxxxxxxx
```

Check it end to end — either with the dashboard's own setup check, which tests every ability
without using any of them:

```bash
curl -s http://127.0.0.1:8787/app/setup | jq '.checks[] | {title, status, detail}'
```

or by hand:

```bash
curl -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/version"
```

A version string means you are done. `Invalid token.` with a **400** (not a 401 — that is
Coolify's actual behaviour) means the token is wrong or was revoked.

## 4. Optional — the outgoing webhook

Without it the dashboard stays current by polling, a few seconds behind. With it, the end
of a deployment, an unreachable server, a full disk or a failed backup arrive instantly,
and the disk gauge gets the only percentage that exists anywhere in Coolify's API surface.

Pick a secret, put it in `.env` as `WEBHOOK_SECRET`, and point Coolify at the dashboard:

```bash
curl -X PATCH "$COOLIFY_URL/api/v1/notifications/webhook" \
     -H "Authorization: Bearer $COOLIFY_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{
       "webhook_enabled": true,
       "webhook_url": "https://dashboard.example.com/app/hooks/coolify?secret=YOUR_SECRET",
       "deployment_success_webhook_notifications": true,
       "deployment_failure_webhook_notifications": true,
       "status_change_webhook_notifications": true,
       "server_unreachable_webhook_notifications": true,
       "backup_failure_webhook_notifications": true
     }'
```

Two things to know:

- **Coolify refuses loopback, link-local and private webhook URLs** (`SafeWebhookUrl`),
  unless the instance operator allowlisted them. A dashboard on `localhost` therefore
  cannot receive webhooks at all — which is fine, polling covers it.
- **The payloads are not signed.** No HMAC, no timestamp, no delivery id. The secret in the
  URL is the only authentication there is, which is why the dashboard refuses to enable the
  route until you set one, and compares it in constant time.

Confirm deliveries are arriving:

```bash
curl -s https://dashboard.example.com/app/health | jq .live
# { "subscribers": 1, "poller": "active", "webhooks": "ready",
#   "lastWebhookAt": "2026-08-19T09:50:11.276Z" }
```

## 5. Optional — CPU and RAM gauges (Sentinel)

Coolify publishes **no REST endpoint for CPU or memory**. Its own charts open an SSH session
and run `docker exec coolify-sentinel curl …` against the Sentinel agent on each server. The
dashboard can make the same round trip, and it needs three things:

1. **Sentinel and its metrics enabled, per server:**

   ```bash
   curl -X PATCH "$COOLIFY_URL/api/v1/servers/<server-uuid>/sentinel" \
        -H "Authorization: Bearer $COOLIFY_TOKEN" \
        -H 'Content-Type: application/json' \
        -d '{"is_sentinel_enabled": true, "is_metrics_enabled": true}'
   ```

2. **`read:sensitive` on the token** — without it Coolify withholds `sentinel_token`
   entirely, and the collector reports that rather than failing obscurely.

3. **An SSH key the servers accept**, given to the dashboard as `METRICS_SSH_KEY`. Either
   the key Coolify itself uses, or a dedicated one added to the servers'
   `authorized_keys`. Setting that variable *is* the opt-in.

Leave any of it out and the gauges stay empty **with the reason on hover** — no collector,
Sentinel off on that server, a stale reading, or a collector that tried and failed. See
[configuration.md](configuration.md#server-metrics-sentinel-over-ssh) for the full set of
knobs.

## Checklist

- [ ] API enabled (`Settings → Advanced → API Access`)
- [ ] Dashboard host allowed (`Settings → Advanced → API allowed IPs`)
- [ ] Token created by an admin/owner, with the abilities you want
- [ ] `COOLIFY_URL` + `COOLIFY_TOKEN` in `.env`, `curl …/api/v1/version` answers
- [ ] *(optional)* `WEBHOOK_SECRET` set and the outgoing webhook pointed at `/app/hooks/coolify`
- [ ] *(optional)* Sentinel metrics enabled per server and `METRICS_SSH_KEY` mounted
