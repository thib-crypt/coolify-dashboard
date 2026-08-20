# Security

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private reporting:
[Security → Report a vulnerability](https://github.com/thib-crypt/coolify-dashboard/security/advisories/new).

Include what you did, what happened, and what you expected. A proof of concept helps, and so
does telling me how you would like to be credited. This is a small project maintained in
spare time: expect a first reply within a week, and a fix or a public advisory once there is
something to say.

Please do not test against instances you do not own.

## Supported versions

The `main` branch is what is supported. There are no maintained release branches yet; once
tagged releases start ([roadmap](docs/roadmap.md#phase-7--packaging-and-plugability)), this
section will say which ones get fixes.

## What this software holds

| Secret | Where it lives | Blast radius if leaked |
|---|---|---|
| `COOLIFY_TOKEN` | The BFF process only — never sent to the browser | Everything the token's abilities allow on your Coolify instance |
| `WEBHOOK_SECRET` | The BFF, and the webhook URL stored in Coolify | Forged dashboard notifications and cache invalidations. Not a path into Coolify. |
| `METRICS_SSH_KEY` | Mounted into the container, read by `ssh` | Whatever that key opens on your servers — use a dedicated one |
| Deployment logs | Held in memory while a build runs, pushed over SSE | Coolify redacts secret values before serving them, but build output is still sensitive |
| `dashboard.sqlite` | `DATA_DIR` | Measurements only: KPI counts and probe results. No credentials. |

## Known limitations

**There is no authentication in front of the dashboard.** This is the one you must design
around. Anyone who can reach the HTTP port can read your fleet's state and trigger deploys,
restarts and stops. Mitigations, in order of preference:

1. Keep it on a private network or bound to loopback (the default: `BFF_HOST=127.0.0.1`, and
   the compose file publishes on `127.0.0.1` too).
2. Put an authenticating proxy in front — Basic Auth on Coolify's Traefik is two labels, and
   an SSO proxy is better ([deployment.md](docs/deployment.md#putting-authentication-in-front-of-it)).
3. Wait for built-in sessions, which are the top item of
   [phase 7](docs/roadmap.md#phase-7--packaging-and-plugability).

**Coolify's outgoing webhooks are unsigned**, so `/app/hooks/coolify` authenticates with a
secret in the query string. That secret will appear in the access logs of anything between
Coolify and the dashboard. It cannot be used to reach Coolify; the worst it allows is a
forged toast and an extra refresh. The route stays disabled (`503`) until you set one.

**The TLS probe does not verify certificates** (`rejectUnauthorized: false`) — an expired
certificate is precisely what it exists to report. It only completes a handshake to read the
certificate and sends no request data.

## What is done on purpose

- **The token never reaches the browser.** That is the reason the BFF exists at all.
- **The webhook secret is compared in constant time**, on the SHA-256 of both sides, so a
  length difference neither throws nor leaks.
- **Webhook deliveries are deduplicated** for two minutes, so Coolify's five retries cannot
  be amplified into five refetches per open tab.
- **The SSH collector never builds a shell command string.** It uses `execFile` with an
  argument array; the only interpolated text on the remote side is the `sentinel_token`,
  re-validated against the character class Coolify itself enforces — no quotes, no `$`, no
  backticks.
- **`StrictHostKeyChecking=accept-new`** by default, so servers are pinned on first sight.
  Setting it to `no` is possible for ephemeral containers and logs a warning at startup.
- **The SSE endpoint is capped at 64 concurrent streams**, so an unauthenticated endpoint
  that holds sockets open cannot be used to exhaust them.
- **The container runs as a non-root user** and needs no capabilities.
- **No telemetry.** The only outbound traffic is to your Coolify instance and to the domains
  of your own applications.
