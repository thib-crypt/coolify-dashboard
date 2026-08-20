/* Domain model of the dashboard — shared by the React SPA and the BFF.
   Everything the UI renders goes through these types. Swap the DataSource
   implementation (mock → BFF) without touching a single component.

   `null` is deliberate throughout: it means "Coolify has no source for this"
   and the UI must render an em dash, never a plausible-looking number. */

/** Coolify environment names are free-form ("production", "staging", "pr-42"). */
export type EnvironmentName = string

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

/**
 * Where `cpu`/`mem` come from — or, far more often, why they are missing.
 *
 * Coolify exposes no REST endpoint for either: its own charts SSH into the
 * server and query the Sentinel agent. This dashboard can do the same
 * (docs/roadmap.md phase 5), but only once it is given an SSH key, so the honest
 * default is an empty gauge that says which of these four silences it is.
 */
export type MetricsSource =
  /** real percentages, read from the server's Sentinel agent */
  | 'sentinel'
  /** no collector configured here — the default install */
  | 'off'
  /** Sentinel metrics are switched off on that server */
  | 'sentinel-off'
  /** Sentinel is on, but its newest sample is too old to pass as current */
  | 'stale'
  /** the collector tried and failed — SSH, the token, the agent */
  | 'error'

/**
 * `cpu`/`mem`: real numbers when `source` is `sentinel`, `null` otherwise —
 * never a plausible-looking figure standing in for one we could not read.
 * `dsk`: the percentage from Coolify's last `high_disk_usage` webhook, and
 * only while that alert still stands; `null` otherwise.
 */
export interface ServerMetrics {
  cpu: number | null
  mem: number | null
  dsk: number | null
  source: MetricsSource
  /** one sentence explaining `source`, shown on hover over the gauges */
  note: string
}

export interface Server {
  id: string
  name: string
  region: string
  /** TCP handshake time from the BFF, `null` when probing is off. */
  pingMs: number | null
  reachable: boolean
  metrics: ServerMetrics
}

/**
 * The four figures under the fleet panel. Coolify's API exposes none of the
 * hardware totals (vCPU/RAM/storage), so the BFF decides what to put here —
 * real counts today, Hetzner inventory later (docs/roadmap.md phase 7).
 */
export type FleetTotals = Array<{ id: string; label: string; value: string }>

export interface Insight {
  id: string
  severity: Trend
  title: string
  description: string
  /** label of the button — always says where it goes */
  action: string
  /**
   * Deep link into Coolify's own UI for the resource this is about. Absent when
   * there is nothing to open (the all-clear row); the button is then inert.
   */
  href?: string
}

export interface Application {
  id: string
  name: string
  domain: string
  initial: string
  /** css gradient used by the app tile */
  gradient: string
  /**
   * Measured by the BFF's own HTTP probes over 24 h ("99.98 %"). `null` — shown
   * as "—" — when the application has no public domain, when probing is off, or
   * before enough samples exist to mean anything.
   */
  uptime: string | null
  /** `null` when the app's settings could not be read. */
  autoDeploy: boolean | null
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

/** What running a palette entry actually does — no string parsing in the UI. */
export type PaletteCommand =
  | { kind: 'deploy'; application: string }
  | { kind: 'restart'; application: string }
  | { kind: 'stop'; application: string }
  | { kind: 'run-task'; owner: 'application' | 'service'; ownerId: string; task: string }
  /** handled by the SPA itself, nothing to send upstream */
  | { kind: 'ui'; target: 'switch-environment' }

export interface PaletteAction {
  id: string
  icon: 'rocket' | 'rotate' | 'stop' | 'clock' | 'logs' | 'server' | 'swap' | 'shield' | 'db' | 'ghost'
  title: string
  shortcut?: string
  command: PaletteCommand
  /** set on destructive entries: shown instead of the title until confirmed */
  confirm?: string
}

export interface Dashboard {
  org: string
  /** the environment this snapshot was built for */
  environment: EnvironmentName
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
