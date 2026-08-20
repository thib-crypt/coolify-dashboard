import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type {
  ActionResponse,
  BffErrorCode,
  BffErrorResponse,
  DegradedNote,
  HealthResponse,
  LiveEvent,
  LiveStatus,
  MetricsStatus,
  ProbeStatus,
  WebhookAck,
} from '../shared/bff'
import type * as Api from '../shared/coolify-api'
import { createActionService, type ActionService } from './actions'
import { TTL, TtlCache } from './cache'
import { isConfigured, loadConfig, loadEnvFile, missingConfig } from './config'
import { CoolifyError, createCoolifyClient, type ApplicationAction, type TaskOwner } from './coolify/client'
import { parseApiDate } from './coolify/mappers'
import { createEventHub } from './events'
import { interpretWebhook, secretMatches } from './hooks'
import { EMPTY_METRICS, createMetricsCollector, metricsTargets } from './metrics'
import { createOverviewService, describeError } from './overview'
import { createPoller } from './poller'
import { EMPTY_SNAPSHOT, createProber, httpTargets, tcpTargets } from './probes'
import { createSignalStore } from './signals'
import { createStore } from './store'

loadEnvFile()

const config = loadConfig()
const store = await createStore(config.dataDir)
const cache = new TtlCache()

const configured = isConfigured(config) ? config : null
const client = configured ? createCoolifyClient(configured) : null

// Webhook-only readings (disk usage) survive here between two deliveries.
const signals = createSignalStore()

const service =
  configured && client
    ? createOverviewService({
        client,
        cache,
        store,
        historyTake: config.deploymentHistoryTake,
        coolifyUrl: configured.coolifyUrl,
        probes: () => prober?.snapshot() ?? EMPTY_SNAPSHOT,
        metrics: () => collector?.snapshot() ?? EMPTY_METRICS,
        signals,
      })
    : null

// Same client, so writes share the reads' cache and can invalidate it in place.
const actions = client ? createActionService({ client, cache }) : null

/* --------------------------------------------------------- live channel ---- */

// The hub starts and stops the poller on the 0 → 1 and 1 → 0 subscriber
// transitions: with no browser listening there is nothing to push to, and
// `/app/overview` refreshes its own cache on demand anyway.
const hub = createEventHub({
  onActivity: hasSubscribers => {
    // The collector follows the poller, not the prober: a CPU gauge builds up
    // no history, so a reading taken while every tab is closed is an SSH
    // connection spent on a number nobody will ever see.
    for (const loop of [poller, collector]) {
      if (!loop) continue
      if (hasSubscribers) loop.start()
      else loop.stop()
    }
  },
})

const poller = client
  ? createPoller({
      client,
      cache,
      hub,
      activeMs: config.pollActiveMs,
      idleMs: config.pollIdleMs,
    })
  : null

/* -------------------------------------------------------------- probes ---- */

/**
 * The prober needs the fleet, which only Coolify can tell it. It reads through
 * the same cache as everything else, with a TTL far longer than the families'
 * own: `/app/overview` and the poller keep those entries warm while anyone is
 * watching, and when nobody is, one refresh every five minutes is all the
 * prober costs upstream. Everything else it does goes to the user's own
 * applications, not to the Coolify API.
 */
const PROBE_TARGETS_TTL = 5 * 60_000

const prober =
  client && config.probes.enabled
    ? createProber({
        store,
        config: config.probes,
        hub,
        targets: async () => {
          const [applications, servers] = await Promise.all([
            cache.fetch('applications', PROBE_TARGETS_TTL, () => client.applications()),
            cache.fetch('servers', PROBE_TARGETS_TTL, () => client.servers()),
          ])
          return {
            applications: httpTargets(applications.value, config.probes.only),
            servers: tcpTargets(servers.value),
          }
        },
      })
    : null

/* ------------------------------------------------------------- metrics ---- */

/**
 * Sentinel's settings barely move, and the token inside them moves only when
 * someone regenerates it — so one read per server every five minutes is enough
 * to keep the collector supplied. That is ~0.2 req/min per server against the
 * 200 req/min budget of appendix B, and it is the collector's *entire* upstream
 * cost: everything else it does is an SSH connection to the user's own server.
 */
const SENTINEL_TTL = 5 * 60_000
const sentinelKey = (uuid: string) => `sentinel:${uuid}`

const collector =
  client && config.metrics.enabled
    ? createMetricsCollector({
        config: config.metrics,
        hub,
        targets: async () => {
          const servers = await cache.fetch('servers', TTL.servers, () => client.servers())
          return metricsTargets(servers.value, config.metrics)
        },
        sentinel: async uuid => {
          const settings = await cache.fetch(sentinelKey(uuid), SENTINEL_TTL, () => client.serverSentinel(uuid))
          return {
            metricsEnabled: settings.value.is_metrics_enabled === true,
            // Absent — not empty — when the token lacks `read:sensitive`.
            token: settings.value.sentinel_token ?? null,
            updatedAt: parseApiDate(settings.value.sentinel_updated_at),
          }
        },
        // A token regenerated in Coolify outlives the cached copy; drop it so the
        // next cycle asks for the current one instead of failing the same way.
        onTokenRejected: uuid => cache.invalidate(sentinelKey(uuid)),
      })
    : null

const metricsStatus = (): MetricsStatus => {
  const snapshot = collector?.snapshot() ?? EMPTY_METRICS
  const readings = [...snapshot.servers.values()]
  return {
    enabled: snapshot.enabled && collector !== null,
    servers: readings.length,
    reporting: readings.filter(reading => reading.source === 'sentinel').length,
    intervalMs: config.metrics.intervalMs,
    lastRunAt: snapshot.lastRunAt === null ? null : new Date(snapshot.lastRunAt).toISOString(),
  }
}

const probeStatus = (): ProbeStatus => {
  const snapshot = prober?.snapshot() ?? EMPTY_SNAPSHOT
  return {
    enabled: snapshot.enabled && prober !== null,
    applications: snapshot.applications.size,
    servers: snapshot.servers.size,
    intervalMs: config.probes.intervalMs,
    lastRunAt: snapshot.lastRunAt === null ? null : new Date(snapshot.lastRunAt).toISOString(),
  }
}

let lastWebhookAt: string | null = null

const liveStatus = (): LiveStatus => ({
  subscribers: hub.subscribers,
  poller: poller?.state ?? 'stopped',
  webhooks: config.webhookSecret ? 'ready' : 'disabled',
  lastWebhookAt,
})

/** What the channel cannot deliver, said once at connection time. */
function liveNotes(): DegradedNote[] {
  const notes: DegradedNote[] = []
  if (!config.webhookSecret) {
    notes.push({
      scope: 'webhooks',
      reason:
        'WEBHOOK_SECRET is not set, so Coolify cannot push here — updates arrive by polling instead (a few seconds slower).',
    })
  }
  if (!poller) {
    notes.push({ scope: 'live', reason: notConfigured.error.message })
  }
  return notes
}

/** Upstream failures are the BFF's problem to explain, not the browser's to decode. */
function toErrorResponse(error: unknown): { status: number; body: BffErrorResponse } {
  if (error instanceof CoolifyError) {
    const codes: Record<string, { code: BffErrorCode; status: number; hint?: string }> = {
      unauthorized: {
        code: 'unauthorized',
        status: 502,
        hint: 'Create a token in Coolify (Security → API Tokens) and set COOLIFY_TOKEN.',
      },
      forbidden: {
        code: 'forbidden',
        status: 502,
        hint: 'The token needs the ability this call requires (`read`, `deploy` or `write`), and its owner must be an admin or owner of the team.',
      },
      api_disabled: {
        code: 'forbidden',
        status: 502,
        hint: 'Enable it in Coolify under Settings → Advanced → API Access.',
      },
      ip_blocked: {
        code: 'forbidden',
        status: 502,
        hint: 'Add this host to the API allowlist in Coolify under Settings → Advanced.',
      },
      queue_full: {
        code: 'queue_full',
        status: 429,
        hint: 'Coolify queues a limited number of deployments per server — this clears as builds finish.',
      },
      rate_limited: { code: 'rate_limited', status: 429 },
      not_found: {
        code: 'not_found',
        status: 404,
        hint: 'The resource may have been deleted, or it belongs to another team.',
      },
      bad_request: { code: 'invalid_state', status: 409 },
      unreachable: { code: 'upstream_unreachable', status: 504, hint: 'Check COOLIFY_URL and that the instance is up.' },
    }
    const mapped = codes[error.code] ?? { code: 'upstream_error' as BffErrorCode, status: 502 }
    return {
      status: mapped.status,
      body: {
        error: {
          code: mapped.code,
          message: describeError(error),
          ...(mapped.hint ? { hint: mapped.hint } : {}),
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        },
      },
    }
  }

  return {
    status: 500,
    body: { error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } },
  }
}

const notConfigured: BffErrorResponse = {
  error: {
    code: 'not_configured',
    message: `Missing ${missingConfig(config).join(' and ')}.`,
    hint: 'Copy .env.example to .env and fill in your Coolify URL and API token.',
  },
}

const app = new Hono()

app.get('/app/health', async c => {
  if (!service) {
    const body: HealthResponse = {
      ok: false,
      service: 'coolify-dashboard-bff',
      now: new Date().toISOString(),
      coolify: { configured: false, url: config.coolifyUrl, version: null },
      notes: [{ scope: 'config', reason: notConfigured.error.message }],
      live: liveStatus(),
      probes: probeStatus(),
      metrics: metricsStatus(),
    }
    return c.json(body, 503)
  }
  const health = await service.health()
  return c.json(
    { ...health, live: liveStatus(), probes: probeStatus(), metrics: metricsStatus() },
    health.ok ? 200 : 502,
  )
})

app.get('/app/overview', async c => {
  if (!service) return c.json(notConfigured, 503)

  try {
    const overview = await service.build(c.req.query('env') ?? null)
    // No browser cache: the SPA refetches *because* a push said the data moved,
    // and a `max-age` would let it answer that refetch from the stale copy.
    // Upstream is still protected — the BFF's own TTL cache is the real one.
    c.header('Cache-Control', 'private, no-store')
    return c.json(overview)
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    console.error(`[overview] ${body.error.code}: ${body.error.message}`)
    if (body.error.retryAfterSeconds) c.header('Retry-After', String(body.error.retryAfterSeconds))
    return c.json(body, status as 429 | 500 | 502 | 504)
  }
})

/* --------------------------------------------------------------- live ---- */

/** Comment frame every 25 s: proxies drop an idle stream long before that. */
const SSE_KEEPALIVE_MS = 25_000
/**
 * A browser opens one stream per tab, so this is generous for its purpose and
 * still bounds an endpoint that holds a socket open and has no auth in front of
 * it yet (`DASHBOARD_PASSWORD` lands in phase 7).
 */
const MAX_SSE_SUBSCRIBERS = 64

app.get('/app/events', c => {
  if (hub.subscribers >= MAX_SSE_SUBSCRIBERS) {
    return c.json(
      {
        error: {
          code: 'internal',
          message: `Too many live connections (${MAX_SSE_SUBSCRIBERS}).`,
          hint: 'Close some dashboard tabs — the data still loads without the live channel.',
        },
      } satisfies BffErrorResponse,
      503,
    )
  }

  return streamSSE(c, async stream => {
    // Writes are serialised through one chain: `writeSSE` is async, the hub
    // calls listeners synchronously, and two interleaved frames would corrupt
    // the stream. Errors are swallowed by `write`, so aborting is what ends it.
    let queue: Promise<unknown> = Promise.resolve()
    const send = (event: LiveEvent) => {
      queue = queue.then(() => stream.writeSSE({ data: JSON.stringify(event) })).catch(() => {})
    }

    const unsubscribe = hub.subscribe(send)
    stream.onAbort(unsubscribe)
    // Backstop: node-server cancels the readable on disconnect, which aborts the
    // stream, but the request signal fires first on an explicit client abort.
    c.req.raw.signal.addEventListener('abort', () => stream.abort(), { once: true })

    send({ type: 'hello', at: new Date().toISOString(), notes: liveNotes() })

    while (!stream.aborted && !stream.closed) {
      await stream.sleep(SSE_KEEPALIVE_MS)
      if (stream.aborted || stream.closed) break
      await stream.write(': keepalive\n\n')
    }

    unsubscribe()
  })
})

/**
 * Coolify's outgoing webhooks land here. The payloads are unsigned, so the
 * secret travels in the query string — which is why the route refuses to exist
 * at all until `WEBHOOK_SECRET` is set.
 *
 * The answer is always fast and always 2xx on an authenticated payload: a
 * non-2xx makes `SendWebhookJob` retry the same event up to five times.
 */
app.post('/app/hooks/coolify', async c => {
  if (!config.webhookSecret) {
    return c.json(
      {
        error: {
          code: 'not_configured',
          message: 'Incoming webhooks are disabled.',
          hint: 'Set WEBHOOK_SECRET on the BFF, then point Coolify at /app/hooks/coolify?secret=…',
        },
      } satisfies BffErrorResponse,
      503,
    )
  }

  if (!secretMatches(config.webhookSecret, c.req.query('secret'))) {
    console.warn('[hooks] rejected a payload with a bad or missing secret')
    return c.json({ error: { code: 'forbidden', message: 'Bad secret.' } } satisfies BffErrorResponse, 403)
  }

  let payload: Api.CoolifyWebhookPayload
  try {
    payload = (await c.req.json()) as Api.CoolifyWebhookPayload
  } catch {
    return badRequest(c, 'Expected a JSON body.')
  }

  const at = new Date().toISOString()
  lastWebhookAt = at
  const effect = interpretWebhook(payload, at)

  for (const prefix of effect.invalidate) cache.invalidate(prefix)
  // Recorded before the dedupe check: a retry carries the same reading, and
  // storing it twice is free, whereas losing it would blank the Fleet gauge.
  for (const signal of effect.signals) signals.record(signal)

  // `publish` returns false when the key was already seen — Coolify retries the
  // same event up to five times, and a retry must stay invisible. A payload with
  // nothing dedupable (a silent backup success) is new by definition.
  let announced = 0
  for (const { event, key } of effect.events) {
    if (hub.publish(event, key)) announced++
  }
  const accepted = effect.events.length === 0 || announced > 0

  // Only a genuinely new payload is worth a refetch in every open tab.
  if (accepted) hub.publish(effect.refresh)

  // The deployment queue moved; the poller can confirm it now instead of in 3 s.
  if (accepted && effect.pokePoller) poller?.poke()

  const ack: WebhookAck = { ok: true, accepted, event: payload.event ?? undefined }
  return c.json(ack, 202)
})

/* ------------------------------------------------------------ actions ---- */

/** Runs one action and answers with `ActionResponse`, or the mapped error. */
async function act(c: Context, run: (service: ActionService) => Promise<ActionResponse>) {
  if (!actions) return c.json(notConfigured, 503)
  try {
    return c.json(await run(actions))
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    console.error(`[action] ${c.req.method} ${c.req.path} → ${body.error.code}: ${body.error.message}`)
    if (body.error.retryAfterSeconds) c.header('Retry-After', String(body.error.retryAfterSeconds))
    return c.json(body, status as ContentfulStatusCode)
  }
}

const badRequest = (c: Context, message: string) =>
  c.json({ error: { code: 'internal', message } } satisfies BffErrorResponse, 400)

/** Bodies are small and optional-ish; a malformed one is the caller's bug. */
async function readBody(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

app.post('/app/deploy', async c => {
  let body: Record<string, unknown>
  try {
    body = await readBody(c)
  } catch {
    return badRequest(c, 'Expected a JSON body.')
  }
  const uuid = typeof body.uuid === 'string' ? body.uuid.trim() : ''
  if (!uuid) return badRequest(c, 'Expected `uuid` in the body.')

  return act(c, service => service.deploy(uuid, { force: body.force === true }))
})

app.post('/app/deployments/:uuid/cancel', c =>
  act(c, service => service.cancelDeployment(c.req.param('uuid'))),
)

app.post('/app/applications/:uuid/autodeploy', async c => {
  let body: Record<string, unknown>
  try {
    body = await readBody(c)
  } catch {
    return badRequest(c, 'Expected a JSON body.')
  }
  if (typeof body.enabled !== 'boolean') return badRequest(c, 'Expected `enabled` to be a boolean.')
  const enabled = body.enabled

  return act(c, service => service.setAutoDeploy(c.req.param('uuid'), enabled))
})

// `start` is here for completeness; the dashboard only surfaces restart and stop.
app.post('/app/applications/:uuid/:action{start|restart|stop}', c =>
  act(c, service => service.applicationAction(c.req.param('uuid'), c.req.param('action') as ApplicationAction)),
)

app.post('/app/:owner{applications|services}/:ownerUuid/tasks/:taskUuid/run', c => {
  // the route pattern only ever matches those two owners
  const owner: TaskOwner = c.req.param('owner') === 'services' ? 'service' : 'application'
  return act(c, service => service.runScheduledTask(owner, c.req.param('ownerUuid'), c.req.param('taskUuid')))
})

app.all('/app/*', c => c.json({ error: { code: 'internal', message: 'No such endpoint.' } }, 404))

const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, info => {
  console.log(`BFF listening on http://127.0.0.1:${info.port}`)
  console.log(
    service
      ? `→ Coolify ${config.coolifyUrl} · snapshots: ${store.kind}`
      : `→ not configured (${missingConfig(config).join(', ')}) — /app/overview will answer 503`,
  )
  if (service) {
    console.log(
      `→ live: SSE on /app/events · poll ${config.pollActiveMs / 1000}s active / ${config.pollIdleMs / 1000}s idle · ` +
        (config.webhookSecret
          ? 'webhooks ready on /app/hooks/coolify?secret=…'
          : 'webhooks disabled (set WEBHOOK_SECRET)'),
    )
    console.log(
      prober
        ? `→ probes: HTTP + TLS every ${config.probes.intervalMs / 1000}s, TCP ping on servers — uptime measured here`
        : '→ probes: disabled (PROBES_ENABLED=false) — uptime, latency and TLS expiry stay unknown',
    )
    console.log(
      collector
        ? `→ metrics: Sentinel over SSH every ${config.metrics.intervalMs / 1000}s using ${config.metrics.sshKeyPath ?? 'the default SSH identity'}`
        : '→ metrics: no collector (set METRICS_SSH_KEY) — CPU and RAM gauges stay empty, with a reason',
    )
    if (collector && config.metrics.strictHostKey === 'no') {
      console.warn('→ metrics: host key checking is off — the SSH connection is not authenticating the server')
    }
  }
})

// Unlike the poller, this one runs whether or not a browser is connected: an
// uptime measured only while someone looks is not an uptime.
prober?.start()

const shutdown = () => {
  // Before `server.close`: an armed poll timer would keep the loop alive.
  poller?.stop()
  prober?.stop()
  collector?.stop()
  server.close(() => {
    store.close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
