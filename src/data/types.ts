export type {
  Application,
  Dashboard,
  Deployment,
  DeploymentState,
  EnvironmentName,
  FleetTotals,
  Insight,
  Kpi,
  PaletteAction,
  ScheduledJob,
  Server,
  ServerMetrics,
  Timeline,
  Trend,
} from '@shared/dashboard'

import type {
  Dashboard,
  EnvironmentName,
  Server,
  ServerMetrics,
} from '@shared/dashboard'

/** Everything the UI needs. Implement this against the BFF to go live. */
export interface DataSource {
  getDashboard(env: EnvironmentName): Promise<Dashboard>
  /** returns the next edge-traffic sample, in req/s */
  sampleTraffic(previous: number): Promise<number> | number
  /** returns fresh metrics for one server */
  sampleServer(server: Server): Promise<ServerMetrics> | ServerMetrics
  triggerDeploy(app: string): Promise<void>
  cancelDeployment(id: string): Promise<void>
  setAutoDeploy(appId: string, enabled: boolean): Promise<void>
}
