import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ActionResponse, BffErrorCode, BffErrorResponse, HealthResponse } from '../shared/bff'
import { createActionService, type ActionService } from './actions'
import { TtlCache } from './cache'
import { isConfigured, loadConfig, loadEnvFile, missingConfig } from './config'
import { CoolifyError, createCoolifyClient, type ApplicationAction, type TaskOwner } from './coolify/client'
import { createOverviewService, describeError } from './overview'
import { createStore } from './store'

loadEnvFile()

const config = loadConfig()
const store = await createStore(config.dataDir)
const cache = new TtlCache()

const configured = isConfigured(config) ? config : null
const client = configured ? createCoolifyClient(configured) : null

const service =
  configured && client
    ? createOverviewService({
        client,
        cache,
        store,
        historyTake: config.deploymentHistoryTake,
        coolifyUrl: configured.coolifyUrl,
      })
    : null

// Same client, so writes share the reads' cache and can invalidate it in place.
const actions = client ? createActionService({ client, cache }) : null

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
    }
    return c.json(body, 503)
  }
  const health = await service.health()
  return c.json(health, health.ok ? 200 : 502)
})

app.get('/app/overview', async c => {
  if (!service) return c.json(notConfigured, 503)

  try {
    const overview = await service.build(c.req.query('env') ?? null)
    // The SPA polls; let it reuse the payload for as long as the BFF would.
    c.header('Cache-Control', `private, max-age=${Math.floor(overview.staleAfterMs / 1000)}`)
    return c.json(overview)
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    console.error(`[overview] ${body.error.code}: ${body.error.message}`)
    if (body.error.retryAfterSeconds) c.header('Retry-After', String(body.error.retryAfterSeconds))
    return c.json(body, status as 429 | 500 | 502 | 504)
  }
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
})

const shutdown = () => {
  server.close(() => {
    store.close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
