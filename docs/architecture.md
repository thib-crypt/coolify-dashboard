# Architecture

## Why there is a server at all

Coolify's API has CORS wide open (`allowed_origins: ['*']` on `api/*`), so a browser
*could* call it directly. Three things make that a bad idea, and together they are the
reason this repo has a `server/` directory:

1. **The token.** Coolify tokens are long-lived and not bound to an origin. In a SPA it
   would sit in the client, readable by every extension and every `curl` of the bundle.
2. **The rate limit.** 200 req/min, counted **per user** across all their tokens. Direct
   browser access multiplies that by the number of open tabs, and the `X-RateLimit-*`
   headers are not readable cross-origin (`exposed_headers: []`), so the client cannot even
   see how close it is.
3. **History.** Uptime, KPI deltas and sparklines need a memory of yesterday. Coolify keeps
   none of it, and neither can a page that is reloaded.

So: one BFF, any number of tabs, a constant upstream cost.

```
┌──────────────┐   SSE + JSON   ┌───────────────────────────┐  Bearer token  ┌──────────────┐
│  React SPA   │ ◄───────────── │  BFF (Hono, TypeScript)   │ ─────────────► │ Coolify API  │
│              │    /app/*      │  · aggregates ~10 calls   │   /api/v1/*    │  (your box)  │
└──────────────┘                │  · adaptive poller + SSE  │                └──────┬───────┘
                                │  · uptime & TLS probes    │   outgoing webhooks   │
                                │  · SQLite history         │ ◄─────────────────────┘
                                │  · serves the built SPA   │
                                └───────────────────────────┘
```

## Layout

```
src/                      React SPA
├── styles/               tokens.css · base.css · layout.css
├── data/
│   ├── types.ts          DataSource interface + the Dashboard model re-exported
│   ├── mock.ts           fixture data — the whole UI runs on this with no instance
│   ├── coolify.ts        live adapter: GET /app/overview + SSE /app/events
│   └── index.ts          the single mock ↔ live switch
├── hooks/
│   ├── useLiveDashboard.ts   payload + live channel + polling fallback
│   ├── useActions.ts         every write, with its toast and its refetch
│   ├── useSession.ts         the password gate, when there is a password
│   └── useDocumentTitle.ts   the tab title follows the route
├── layout/
│   ├── Shell.tsx         the layout route: rail, topbar, palette, one live channel
│   └── context.ts        what pages read through `useShell()`
├── pages/                one file per route, no data plumbing of their own
└── components/           one CSS file per component, media queries beside their rule

shared/                   imported by both sides
├── dashboard.ts          the Dashboard model every component consumes
├── coolify-api.ts        Coolify API types, written by hand (see below)
└── bff.ts                the /app/* contract

server/                   BFF (Hono)
├── index.ts              routes, wiring, shutdown
├── config.ts             every environment variable, in one place
├── coolify/
│   ├── client.ts         typed fetch: Bearer, error classification, verb fallbacks
│   └── mappers.ts        pure functions, Coolify API → Dashboard
├── auth.ts               the password gate: signed cookie, no session store
├── setup.ts              the first-run diagnostic behind GET /app/setup
├── overview.ts           the aggregator: ~10 endpoints → one Dashboard, plus the
│                         per-resource reads the pages need
├── actions.ts            writes: reads what Coolify *actually* did, purges the cache
├── cache.ts              per-family TTL cache: single-flight + stale-on-upstream-failure
├── concurrency.ts        mapLimit: bounds the fan-outs (one call per app, per server)
├── events.ts             SSE hub: broadcast + poller/webhook deduplication
├── poller.ts             adaptive loop, stopped while nobody is listening
├── hooks.ts              incoming webhooks: constant-time secret, payload → effects
├── signals.ts            what only a webhook carries (disk %), with an expiry
├── probes.ts             outbound HTTP + TLS + TCP → uptime, latency, cert expiry
├── metrics.ts            Sentinel over SSH (opt-in) → CPU/RAM, or a reasoned "—"
├── store.ts              node:sqlite — hourly KPI snapshots and every probe result
└── static.ts             serves the built SPA in production
```

**The Coolify API types are hand-written**, not generated. The upstream `openapi.json` has
known drift — the response shape of `/deployments/applications/{uuid}` is wrong, some routes
are missing, `GET /resources` is unspecified — so they were written against
`routes/api.php` and the controllers instead. The traps that came out of that reading are
collected in [coolify-api-notes.md](coolify-api-notes.md).

## A request for the dashboard

1. The SPA calls `GET /app/overview?env=production`.
2. `overview.ts` asks for roughly ten families of data. Each goes through `cache.ts`, which
   serves a fresh entry, joins an in-flight request for the same key (single-flight), or
   fetches. Twenty tabs asking at once produce one upstream call.
3. Fan-outs — application details, deployment history, scheduled tasks — go through
   `mapLimit` so a fleet of fifty applications does not open fifty sockets.
4. `mappers.ts` turns raw API objects into the `Dashboard` model. These are **pure
   functions**, which is why the parsing traps (`"running:healthy"`, JSON-string logs,
   timezone-less timestamps, cron positions) are unit-tested without a network.
5. Anything that could not be read becomes a **degraded note** rather than a failure: the
   payload still renders, with `—` where a number would have lied.
6. If Coolify goes down mid-refresh, the cache serves its last known value rather than an
   error — a dashboard that goes blank the moment the instance hiccups is worse than one
   that says "as of two minutes ago".

## Pages, and why navigating is free

`react-router` in declarative mode, with one **layout route** — `src/layout/Shell.tsx` —
holding the rail, the topbar, the command palette, the toasts, and the single
`useLiveDashboard`. Pages are children of it and read what they need through `useShell()`.

That shape is the whole point: the SSE stream is opened once and survives navigation, and a
page change issues **no upstream request at all**. The reads that pages do add
(`/app/deployments`, `/app/applications/:uuid`) hit the same cache families the aggregator
already fills, so the rate-limit budget is a function of time and of the fleet's size —
never of how much someone clicks.

Two consequences worth knowing:

- **The environment is a shell-level value**, so every scoped read has to carry it. The
  history and application pages pass `env`; without it the BFF would answer for the team's
  first environment while the topbar showed another.
- **`<Outlet key={data.environment}>`**: switching environments replaces the data
  underneath, so panels replay their entrance rather than mutating in place.

## The live channel

Two sources, deliberately overlapping:

| Source | Sees | Latency |
|---|---|---|
| Poller on `/deployments` | Builds **starting**, logs growing, builds ending | 2.5 s active / 4 s idle |
| Incoming webhooks | Builds ending, server unreachable, disk full, backup/task failures | Immediate |

Webhooks are the fast path *when they are configured*; the poller is the floor when they are
not. Neither is required.

Three decisions worth knowing:

- **One poller, not two.** `/deployments` already carries `logs` when the token has
  `read:sensitive`, so additionally polling each running deployment would double the cost
  and learn nothing. `GET /deployments/{uuid}` is used for exactly one thing: reading the
  terminal status of a deployment that just left the list.
- **4 s at idle, not 15 s.** No Coolify webhook announces the *start* of a deployment — the
  twenty outgoing events cover success, failure, status, backups, tasks and servers, never a
  build beginning. So this cadence *is* the detection latency for a deployment launched from
  Coolify's own UI. Measured end to end: 3.6 s.
- **The poller stops when the last tab closes.** At rest, with nobody watching, the BFF
  makes no deployment requests at all. That is what pays for the fast cadence when someone
  is.

The SPA is not helpless if the stream dies — a buffering proxy, a corporate filter, a
laptop that slept. It falls back to fetching every 10 s instead of every 60 s.

## Probes: measuring what Coolify does not

Coolify knows whether *it* can reach a server over SSH, and what Docker says about a
container. Neither answers "does the site respond?", and no endpoint does.

| Probe | Cadence | Produces |
|---|---|---|
| HTTP on each `fqdn` | 60 s | Measured 24 h uptime, average latency, outage detection |
| TLS handshake | 1 h | Certificate expiry (`rejectUnauthorized: false` — an expired certificate is exactly what we want to read) |
| TCP to the server IP | 60 s | The `ping` the Fleet column used to show as `—` |

Every HTTP result is a row in SQLite, so the percentage is a measurement that survives a
restart. These requests go to your applications, not to Coolify, so they spend none of the
rate-limit budget — only the *target list* is read upstream, through the same cache with a
5 minute TTL.

Three guards against false alarms: **3 consecutive failures** before declaring an outage,
**5 samples** before showing a percentage, and **one alert per problem** — if Coolify
already says the container is `exited`, the probe does not say it again.

## Server metrics: the honest gap

Coolify's own CPU and memory charts go through `app/Traits/HasMetrics.php`, which opens an
SSH session and runs `docker exec coolify-sentinel curl …` against the agent on each server.
The API exposes only Sentinel's *configuration*. There is no REST route for the numbers.

So the collector makes the same trip, in **one SSH connection per server per cycle** — both
`curl`s in a single `docker exec`, separated by a marker, because two JSON arrays printed
back to back cannot be split apart again. Four decisions that are not the obvious ones:

- **`execFile` with an argument array**, never a string handed to a local shell. The only
  interpolated text on the remote side is the `sentinel_token`, re-validated against the
  character class Coolify itself enforces (`ServerSetting::isValidSentinelToken`) — no
  quotes, no `$`, no backticks — so the interpolation is safe by construction.
- **The loop stops when nobody is watching**, like the poller and unlike the probes: a gauge
  accumulates no history, so a reading taken with every tab closed is an SSH connection spent
  on a number nobody will see.
- **A reading older than two minutes is not displayed.** Sentinel refreshes every 10 s;
  two minutes of silence means the agent stopped collecting, not that the server is idle.
  The gauge returns to `—` with the delay and the last agent contact.
- **`StrictHostKeyChecking=accept-new`**, where Coolify uses `no`. Coolify constantly
  churns through every server's keys; a dashboard that talks to a handful of fixed hosts can
  afford to pin them on first sight.

Without a key, the gauges are empty — but an empty gauge says **which** of four silences it
is (`off`, `sentinel-off`, `stale`, `error`), on hover and in the degraded notes. That is
the difference between "we were never given a way to read this" and "the agent is down",
which three identical em dashes would erase.

## Conventions

- **Comments explain why, not what.** A comment that restates the code is deleted; a comment
  that records a trap, a measurement or a rejected alternative is kept.
- **Nothing is estimated.** If the API cannot provide a number, the UI shows `—` and a
  degraded note explains it. Two KPIs from the original design were *replaced* rather than
  faked.
- **Mappers are pure.** Everything that parses upstream shapes is a function of its input,
  and is tested without a network.
- **The front end never learns a Coolify uuid's meaning.** It posts intents to the BFF,
  which translates them.

Design decisions that were considered and rejected, phase by phase, are recorded in
[roadmap.md](roadmap.md).
