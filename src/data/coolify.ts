/* Live adapter — skeleton (phase 1).
   Will call this repo's BFF (`/app/overview`), never Coolify from the browser.
   Swap the export in src/data/index.ts when ready:
     export const source = createCoolifySource()
   No component needs to change: they only ever see the `Dashboard` shape. */

import type { Dashboard, DataSource, EnvironmentName, Server, ServerMetrics } from './types'

export interface CoolifyConfig {
  /** e.g. https://coolify.example.com */
  baseUrl: string
  token: string
}

export function createCoolifySource(config: CoolifyConfig): DataSource {
  const api = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${config.baseUrl}/api/v1${path}`, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Coolify ${path} → ${res.status} ${res.statusText}`)
    return res.json() as Promise<T>
  }

  return {
    async getDashboard(_env: EnvironmentName): Promise<Dashboard> {
      // GET /applications  → applications[] + applicationCount
      // GET /servers       → servers[] + fleetTotals
      // GET /deployments   → deployments[] + deploymentCount
      // (KPIs, insights and the schedule timeline are derived from the above)
      void api
      throw new Error('createCoolifySource: not implemented yet — map the endpoints above.')
    },

    sampleTraffic(previous: number) {
      // No traffic endpoint in Coolify core — plug your proxy/Traefik metrics here.
      return previous
    },

    sampleServer(server: Server): ServerMetrics {
      // GET /servers/{uuid}/resources
      return server.metrics
    },

    async triggerDeploy(_app: string) {
      // GET /deploy?uuid={uuid}
    },

    async cancelDeployment(_id: string) {
      // POST /deployments/{uuid}/cancel
    },

    async setAutoDeploy(_appId: string, _enabled: boolean) {
      // PATCH /applications/{uuid} { instant_deploy / git webhook settings }
    },
  }
}
