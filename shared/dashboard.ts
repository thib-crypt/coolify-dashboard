/* Domain model of the dashboard — shared by the React SPA and the BFF.
   Everything the UI renders goes through these types. Swap the DataSource
   implementation (mock → BFF) without touching a single component. */

export type EnvironmentName = 'Production' | 'Staging'

export type Trend = 'ok' | 'warn' | 'err' | 'neutral'

export interface Kpi {
  id: string
  /** icon key resolved in components/icons.tsx */
  icon: 'apps' | 'deployments' | 'latency' | 'cost'
  label: string
  /** small pill on the top-right of the card */
  badge: { text: string; trend: Trend; caret?: boolean }
  value: string
  /** rendered smaller + muted right after the value (ms, .20, …) */
  unit?: string
  sub: string
  /** sparkline points in the 84×30 viewBox of the mockup */
  spark: Array<[number, number]>
}

export type DeploymentState = 'running' | 'success' | 'failed' | 'cancelled'

export interface Deployment {
  id: string
  app: string
  message: string
  branch: string
  sha: string
  state: DeploymentState
  /** finished deployments: human duration ("1m 42s"); running: seconds elapsed */
  duration?: string
  elapsedSeconds?: number
  when?: string
  /** running deployments only — rotated in the ticker */
  logs?: string[]
}

export interface ServerMetrics {
  cpu: number
  mem: number
  dsk: number
}

export interface Server {
  id: string
  name: string
  region: string
  pingMs: number
  reachable: boolean
  metrics: ServerMetrics
}

export interface FleetTotals {
  vcpu: string
  memory: string
  storage: string
  regions: string
}

export interface Insight {
  id: string
  severity: Trend
  title: string
  description: string
  action: string
}

export interface Application {
  id: string
  name: string
  domain: string
  initial: string
  /** css gradient used by the app tile */
  gradient: string
  uptime: string
  autoDeploy: boolean
}

export interface ScheduledJob {
  id: string
  title: string
  /** "02:00 · every day · → S3" */
  detail: string
  /** horizontal position on the 24 h timeline, in % */
  left: number
}

export interface Timeline {
  now: { left: number; label: string }
  ticks: Array<{ left: number; label: string }>
  jobs: ScheduledJob[]
}

export interface PaletteAction {
  id: string
  icon: 'rocket' | 'rotate' | 'logs' | 'server' | 'swap' | 'shield' | 'db' | 'ghost'
  title: string
  shortcut?: string
}

export interface Dashboard {
  org: string
  environments: EnvironmentName[]
  systemStatus: { ok: boolean; label: string }
  kpis: Kpi[]
  deployments: Deployment[]
  deploymentCount: number
  servers: Server[]
  fleetTotals: FleetTotals
  insights: Insight[]
  applications: Application[]
  applicationCount: number
  timeline: Timeline
  paletteActions: PaletteAction[]
}
