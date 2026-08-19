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
  PaletteCommand,
  ScheduledJob,
  Server,
  ServerMetrics,
  Timeline,
  Trend,
} from '@shared/dashboard'

export type { ActionOutcome, ActionResponse, LiveEvent, ToastTone } from '@shared/bff'

import type { ActionResponse, LiveEvent } from '@shared/bff'
import type {
  Dashboard,
  EnvironmentName,
  Server,
  ServerMetrics,
} from '@shared/dashboard'

/**
 * What a source pushes. `offline` never crosses the wire: it is the adapter's
 * own way of saying the transport dropped, so the UI can stop pretending the
 * numbers on screen are live.
 */
export type LiveUpdate = LiveEvent | { type: 'offline' }

/** Everything the UI needs. Implemented twice: mock, and the BFF (`src/data/coolify.ts`). */
export interface DataSource {
  /** `null` lets the source pick its default environment and report it back. */
  getDashboard(env: EnvironmentName | null): Promise<Dashboard>
  /** first edge-traffic sample, or `null` when the source has no traffic data */
  initialTraffic(): number | null
  /** next edge-traffic sample in req/s, or `null` when there is no source */
  sampleTraffic(previous: number): number | null
  /** fresh metrics for one server (fields stay `null` without a metrics source) */
  sampleServer(server: Server): ServerMetrics
  /**
   * Server-pushed updates. Returns an unsubscribe function. A source with no
   * live channel subscribes to nothing and never calls back — the caller then
   * falls back to polling, which is why this cannot simply be optional.
   */
  subscribe(listener: (update: LiveUpdate) => void): () => void
  /* Actions. They resolve with what Coolify actually did — a queued deployment
     and a skipped one both come back as a success, so the caller must look at
     `outcome` rather than assume the click had an effect. */
  triggerDeploy(appId: string): Promise<ActionResponse>
  cancelDeployment(deploymentId: string): Promise<ActionResponse>
  setAutoDeploy(appId: string, enabled: boolean): Promise<ActionResponse>
  restartApplication(appId: string): Promise<ActionResponse>
  stopApplication(appId: string): Promise<ActionResponse>
  runScheduledTask(owner: 'application' | 'service', ownerId: string, taskId: string): Promise<ActionResponse>
}

/** Carries the BFF's error vocabulary through to the UI. */
export class DashboardError extends Error {
  readonly code: string
  readonly hint?: string
  /** set on 429s — how long Coolify asked us to wait */
  readonly retryAfterSeconds?: number

  constructor(code: string, message: string, hint?: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'DashboardError'
    this.code = code
    this.hint = hint
    this.retryAfterSeconds = retryAfterSeconds
  }
}
