/* Live adapter (phases 1–2).
   Calls this repo's BFF — never Coolify directly: the API token stays on the
   server, and one BFF serves any number of tabs within Coolify's per-user
   rate limit. Components never learn the difference: they only see `Dashboard`
   and `ActionResponse`. */

import { DashboardError, SESSION_LOST } from './types'
import type {
  ActionResponse,
  Dashboard,
  DataSource,
  EnvironmentName,
  LiveUpdate,
  Server,
  ServerMetrics,
  SessionResponse,
  SetupReport,
} from './types'
import type {
  ApplicationDetailResponse,
  ApplicationLogsResponse,
  DeploymentHistoryResponse,
} from '@shared/bff'
import type { BffErrorResponse, LiveEvent, OverviewResponse } from '@shared/bff'

async function readError(res: Response): Promise<DashboardError> {
  let body: Partial<BffErrorResponse> = {}
  try {
    body = (await res.json()) as BffErrorResponse
  } catch {
    // non-JSON error (proxy, dev server) — fall through to the status line
  }
  const error = body.error
  // A 401 means this browser's session is gone, whatever it was asking for.
  // Said once, here, so no caller has to recognise it: the gate listens.
  if (res.status === 401 && error?.code === 'unauthenticated') {
    dispatchEvent(new Event(SESSION_LOST))
  }
  return new DashboardError(
    error?.code ?? 'internal',
    error?.message ?? `The dashboard API answered ${res.status} ${res.statusText}.`,
    error?.hint,
    error?.retryAfterSeconds,
  )
}

export function createBffSource(basePath = '/app'): DataSource {
  async function call(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${basePath}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      })
    } catch {
      throw new DashboardError(
        'unreachable',
        'Cannot reach the dashboard API.',
        'Is the BFF running? `npm run dev` starts it on port 8787.',
      )
    }
  }

  /** Every action goes through here, so they all fail the same way. */
  async function act(path: string, body?: unknown): Promise<ActionResponse> {
    const res = await call(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) throw await readError(res)
    return (await res.json()) as ActionResponse
  }

  const app = (id: string) => `/applications/${encodeURIComponent(id)}`

  /** The session routes answer the same shape whatever the verb. */
  async function session(method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<SessionResponse> {
    const res = await call('/session', {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) throw await readError(res)
    return (await res.json()) as SessionResponse
  }

  return {
    async getDashboard(env: EnvironmentName | null): Promise<Dashboard> {
      const query = env ? `?env=${encodeURIComponent(env)}` : ''
      const res = await call(`/overview${query}`)
      if (!res.ok) throw await readError(res)

      const body = (await res.json()) as OverviewResponse
      return body.dashboard
    },

    /**
     * SSE, one listener: the BFF sends unnamed frames so everything lands on
     * `message` with its kind inside the payload.
     *
     * `EventSource` reconnects by itself, and the BFF is idempotent about what
     * it pushes — log frames carry their absolute offset, finished deployments
     * are keyed — so a reconnection needs nothing rebuilt by hand. An `error`
     * only means the transport dropped; it is reported so the UI stops
     * pretending, and the next `hello` says it is back.
     */
    subscribe(listener: (update: LiveUpdate) => void): () => void {
      const stream = new EventSource(`${basePath}/events`)

      stream.onmessage = message => {
        try {
          listener(JSON.parse(message.data as string) as LiveEvent)
        } catch {
          // A frame we cannot parse is not a reason to tear the channel down.
        }
      }
      stream.onerror = () => listener({ type: 'offline' })

      return () => {
        stream.onmessage = null
        stream.onerror = null
        stream.close()
      }
    },

    // No traffic source in Coolify core — the strip says so instead of inventing one.
    initialTraffic: () => null,
    sampleTraffic: () => null,

    // No REST endpoint for CPU/RAM/disk; the gauges stay empty until phase 5.
    sampleServer: (server: Server): ServerMetrics => server.metrics,

    triggerDeploy: appId => act('/deploy', { uuid: appId }),
    cancelDeployment: id => act(`/deployments/${encodeURIComponent(id)}/cancel`),
    setAutoDeploy: (appId, enabled) => act(`${app(appId)}/autodeploy`, { enabled }),
    restartApplication: appId => act(`${app(appId)}/restart`),
    stopApplication: appId => act(`${app(appId)}/stop`),
    runScheduledTask: (owner, ownerId, taskId) =>
      act(`/${owner}s/${encodeURIComponent(ownerId)}/tasks/${encodeURIComponent(taskId)}/run`),

    async getDeployments({ env, skip = 0, take = 50, application }) {
      const query = new URLSearchParams({ skip: String(skip), take: String(take) })
      // Without it the BFF answers for the team's first environment, which is
      // not necessarily the one the topbar is showing.
      if (env) query.set('env', env)
      if (application) query.set('app', application)
      const res = await call(`/deployments?${query.toString()}`)
      if (!res.ok) throw await readError(res)
      return (await res.json()) as DeploymentHistoryResponse
    },

    async getApplication(uuid) {
      const res = await call(app(uuid))
      if (!res.ok) throw await readError(res)
      return (await res.json()) as ApplicationDetailResponse
    },

    async getApplicationLogs(uuid, lines = 200) {
      const res = await call(`${app(uuid)}/logs?lines=${lines}`)
      if (!res.ok) throw await readError(res)
      return (await res.json()) as ApplicationLogsResponse
    },

    rollback: (uuid, commit) => act(`${app(uuid)}/rollback`, { commit }),

    async getSetup() {
      const res = await call('/setup')
      if (!res.ok) throw await readError(res)
      return (await res.json()) as SetupReport
    },

    getSession: () => session('GET'),
    signIn: password => session('POST', { password }),
    signOut: () => session('DELETE'),
  }
}
