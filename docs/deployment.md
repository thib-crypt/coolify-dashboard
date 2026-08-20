# Deployment

The dashboard ships as a single container: one Node process that serves the built SPA and
the `/app/*` API from the same origin. Nothing else is required — SQLite is a file, and the
only outbound traffic is to your Coolify instance and to your own applications.

> **Read [the Security section of the README](../README.md#security) first.** There is no
> authentication in front of the dashboard yet. Whoever reaches it can deploy and stop
> things. Everything below assumes you either keep it private or put an authenticating proxy
> in front of it.

## Anywhere Docker runs

```bash
git clone https://github.com/thib-crypt/coolify-dashboard.git
cd coolify-dashboard
cp .env.example .env      # COOLIFY_URL and COOLIFY_TOKEN at minimum
docker compose up -d --build
```

`docker-compose.yml` publishes on `127.0.0.1:8787` deliberately. The image sets
`BFF_HOST=0.0.0.0` inside the container, `DATA_DIR=/data` on a named volume, and
`STATIC_DIR=/app/dist`.

Verify:

```bash
curl -s http://127.0.0.1:8787/app/health | jq '{ok, coolify, live, probes, metrics}'
```

`ok: false` here means Coolify is unreachable or the token is wrong — the container itself
is fine, and its health check reflects that on purpose (it asks whether the BFF answers, not
whether your instance is up).

### Building the image yourself

```bash
docker build -t coolify-dashboard .
docker run -d --name coolify-dashboard \
  -p 127.0.0.1:8787:8787 \
  -v coolify-dashboard-data:/data \
  -e COOLIFY_URL=https://coolify.example.com \
  -e COOLIFY_TOKEN=... \
  coolify-dashboard
```

The build is multi-stage: `npm ci`, type-check, bundle the SPA into `dist/` and the BFF into
one ESM file with its dependencies inlined. The runtime layer carries no `node_modules` and
runs as the unprivileged `node` user. `openssh-client` is installed for the one optional
feature that needs it, the Sentinel metrics collector.

## On Coolify itself

The dashboard is a normal Docker Compose resource. It can absolutely live on the instance it
watches — with the caveat that it then goes down with it, which is the one moment you would
want it.

1. **New Resource → Docker Compose**, pointed at this repository (or a fork of it).
2. **Set the environment variables** in Coolify's UI: `COOLIFY_URL`, `COOLIFY_TOKEN`, and
   whichever optional ones you want from [configuration.md](configuration.md).
3. **Remove the `ports:` block** from `docker-compose.yml` in your fork, or leave it: the
   Coolify proxy reaches the container over the Docker network either way, and a published
   loopback port is only there for the standalone case.
4. **Attach a domain** to the service on port `8787`. Coolify's proxy terminates TLS.
5. **Add the dashboard host to the API allowlist** — `Settings → Advanced` — if you use one.
   A container on the same box still arrives with an IP.
6. **Point the outgoing webhook** at `https://<your-domain>/app/hooks/coolify?secret=…`, as
   in [coolify-setup.md](coolify-setup.md#4-optional--the-outgoing-webhook). This is the
   step that makes the dashboard react instantly instead of within a few seconds.

### Putting authentication in front of it

Coolify runs Traefik, which does Basic Auth with two labels. In your compose service:

```yaml
    labels:
      - traefik.http.middlewares.dashboard-auth.basicauth.users=admin:$$apr1$$...   # htpasswd, $ doubled
      - traefik.http.routers.<router-name>.middlewares=dashboard-auth
```

Generate the hash with `htpasswd -nB admin` and **double every `$`** — Compose interpolates
single ones. Browsers keep sending those credentials on the SSE stream, since it is
same-origin, so the live channel keeps working.

For anything more than one shared password, put an SSO proxy (oauth2-proxy, Authelia,
Authentik, Cloudflare Access) in front instead. Built-in sessions are
[on the roadmap](roadmap.md#phase-7--packaging-and-plugability).

## Behind your own reverse proxy

The only unusual requirement is the SSE stream on `GET /app/events`. It must not be
buffered, and it must not be timed out at 60 seconds.

**Nginx:**

```nginx
location /app/events {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}

location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
}
```

**Caddy** and **Traefik** need nothing special; both stream by default.

If the stream cannot get through, nothing breaks: the SPA notices and falls back to fetching
every 10 s. You can tell which mode you are in from `/app/health` — `live.subscribers` stays
at `0` when no stream is actually established.

## State and backups

Everything persistent is one SQLite file in `DATA_DIR` (`/data` in the container):

- hourly KPI snapshots, which produce the "+2 this week" deltas and the sparklines;
- every probe result, which is what makes the uptime percentage a measurement.

Losing it is not fatal — the dashboard restarts empty and rebuilds history as it runs. To
back it up, copy the file (SQLite is happy with a copy of a quiet database, and this one is
written a few times a minute at most):

```bash
docker run --rm -v coolify-dashboard_dashboard-data:/data -v "$PWD":/backup alpine \
  cp /data/dashboard.sqlite /backup/dashboard-$(date +%F).sqlite
```

## Upgrading

```bash
git pull
docker compose up -d --build
```

The schema is created with `CREATE TABLE IF NOT EXISTS` and only ever added to, so the
volume carries across versions. Check `/app/health` after the restart; the version of the
Coolify instance it is talking to is in `coolify.version`.

## Footprint

| | |
|---|---|
| Image | ~237 MB, most of which is the Node 24 Alpine base |
| Memory | ~55 MB resident when idle; it grows with the size of the fleet it holds in memory |
| Upstream cost | Under 36 req/min with tabs open, ~0.4 req/min with none |
| Outbound | One HTTP request per application per minute, to your own domains |
