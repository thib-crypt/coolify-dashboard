/* Live adapter (phases 1–2).
   Calls this repo's BFF — never Coolify directly: the API token stays on the
   server, and one BFF serves any number of tabs within Coolify's per-user
   rate limit. Components never learn the difference: they only see `Dashboard`
   and `ActionResponse`. */

import { DashboardError } from './types'
import type {
  ActionResponse,
  Dashboard,
  DataSource,
  EnvironmentName,
  Server,
  ServerMetrics,
} from './types'
import type { BffErrorResponse, OverviewResponse } from '@shared/bff'

async function readError(res: Response): Promise<DashboardError> {
  let body: Partial<BffErrorResponse> = {}
  try {
    body = (await res.json()) as BffErrorResponse
  } catch {
    // non-JSON error (proxy, dev server) — fall through to the status line
  }
  const error = body.error
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

  return {
    async getDashboard(env: EnvironmentName | null): Promise<Dashboard> {
      const query = env ? `?env=${encodeURIComponent(env)}` : ''
      const res = await call(`/overview${query}`)
      if (!res.ok) throw await readError(res)

      const body = (await res.json()) as OverviewResponse
      return body.dashboard
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
  }
}
