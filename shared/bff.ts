/** Contract between the React SPA and this repo's BFF (`/app/*`).
    The browser never talks to Coolify: it only ever sees these shapes. */

import type { Dashboard, Deployment, DeploymentState } from './dashboard'

/**
 * What `GET /app/health` answers to a caller with no session, once
 * `DASHBOARD_PASSWORD` is set. It is deliberately thin: the full body names the
 * Coolify instance and its version, and a liveness probe does not need either.
 */
export interface GuardedHealthResponse {
  ok: boolean
  service: 'coolify-dashboard-bff'
  now: string
  auth: AuthStatus
}

export interface HealthResponse extends GuardedHealthResponse {
  coolify: {
    /** false when COOLIFY_URL / COOLIFY_TOKEN are missing */
    configured: boolean
    url: string | null
    /** plain-text `GET /api/v1/version`, null when unreachable or unconfigured */
    version: string | null
  }
  /** what the BFF could not read this run — same vocabulary as OverviewResponse */
  notes: DegradedNote[]
  /** state of the push channel (phase 3) */
  live: LiveStatus
  /** state of the outbound probes (phase 4) */
  probes: ProbeStatus
  /** state of the Sentinel metrics collector (phase 5) */
  metrics: MetricsStatus
}

/** Whether this deployment has a front door, and whether the caller is through it. */
export interface AuthStatus {
  /** true once DASHBOARD_PASSWORD is set on the BFF */
  required: boolean
  /** always true when `required` is false — an open dashboard admits everyone */
  authenticated: boolean
}

/**
 * Answer of `GET /app/deployments`. The overview carries five rows because that
 * is what fits in its panel; this is the same data, unabridged and paginated.
 */
export interface DeploymentHistoryResponse {
  generatedAt: string
  environment: string
  /** deployments known for this environment, across every application */
  total: number
  /** the slice asked for, newest first */
  deployments: Deployment[]
  skip: number
  take: number
  notes: DegradedNote[]
}

/* ------------------------------------------------- one application ------- */

/** One environment variable, as much of it as the token is allowed to see. */
export interface AppEnvVar {
  key: string
  /** `null` when Coolify withheld it — the token has no `read:sensitive` */
  value: string | null
  /** true when Coolify only ever shows this value once, so nobody can read it back */
  writeOnly: boolean
  buildTime: boolean
  preview: boolean
}

/** An image already built and present on the server, ready to be redeployed. */
export interface RollbackTarget {
  /** what a rollback is asked for — Coolify calls it `commit`, it is an image tag */
  tag: string
  createdAt: string | null
  /** the one the running container was built from */
  current: boolean
}

/** Answer of `GET /app/applications/:uuid`. */
export interface ApplicationDetailResponse {
  generatedAt: string
  uuid: string
  name: string
  description: string | null
  /** primary public domain, empty when the application has none */
  domain: string
  /** Coolify's compound `running:healthy` string, split */
  status: { state: string; health: string | null }
  repository: string | null
  branch: string | null
  buildPack: string | null
  autoDeploy: boolean | null
  /** measured here, `null` before enough samples or with no public domain */
  uptime: string | null
  /** the Coolify page for this application */
  link: string | null
  environment: string | null
  serverName: string | null
  envs: AppEnvVar[]
  rollback: {
    /** tag the running container was built from, when it could be read */
    current: string | null
    targets: RollbackTarget[]
  }
  notes: DegradedNote[]
}

/** Answer of `GET /app/applications/:uuid/logs`. */
export interface ApplicationLogsResponse {
  /** newest last, already split; empty when the container is not running */
  lines: string[]
  /** why there are no lines, when there are none */
  note: string | null
}

/* -------------------------------------------------- first-run diagnostic -- */

export type CheckStatus =
  /** works */
  | 'ok'
  /** works, but something is off or unavailable that you may want */
  | 'warn'
  /** the dashboard cannot do its job until this is fixed */
  | 'fail'
  /** could not be determined — the reason is in `detail` */
  | 'unknown'

/** One thing `GET /app/setup` looked at, and what to do about what it found. */
export interface SetupCheck {
  id: string
  title: string
  status: CheckStatus
  /** what was observed, in one sentence */
  detail: string
  /** what to do about it, when there is something to do */
  hint?: string
  /** the Coolify page where it gets fixed */
  link?: string
}

export interface SetupReport {
  generatedAt: string
  /** true when nothing is `fail`: the dashboard will work, warnings and all */
  ok: boolean
  coolifyUrl: string | null
  /** plain-text version of the instance, when it answered */
  version: string | null
  /** the team the token belongs to, when it could be read */
  team: string | null
  checks: SetupCheck[]
}

/** Answer of `GET`, `POST` and `DELETE` on `/app/session`. */
export interface SessionResponse extends AuthStatus {
  /** when the current session stops being valid, null when there is none */
  expiresAt: string | null
}

/**
 * Whether the Fleet gauges have a source behind them.
 *
 * Coolify publishes no metrics endpoint, so `enabled: false` — the default —
 * is a statement about this deployment, not a fault: it means no SSH key was
 * given to the BFF and CPU/RAM will render as em dashes with a reason.
 */
export interface MetricsStatus {
  /** true once METRICS_SSH_KEY is set and the collector is running */
  enabled: boolean
  /** servers the collector queries */
  servers: number
  /** of those, how many returned real percentages on the last cycle */
  reporting: number
  intervalMs: number
  /** end of the last full cycle, null before the first one */
  lastRunAt: string | null
}

/** How the BFF is measuring what Coolify does not measure. */
export interface ProbeStatus {
  /** false when PROBES_ENABLED is off — uptime, latency and TLS are then unknown */
  enabled: boolean
  /** applications with a public domain currently being probed */
  applications: number
  /** servers being TCP-probed for latency */
  servers: number
  intervalMs: number
  /** end of the last full cycle, null before the first one */
  lastRunAt: string | null
}

/** How the BFF is currently learning that something changed. */
export interface LiveStatus {
  /** open SSE connections */
  subscribers: number
  /** `stopped` while nobody is watching — the poller costs nothing then */
  poller: 'stopped' | 'idle' | 'active'
  /** `disabled` until WEBHOOK_SECRET is set; `ready` once the route accepts posts */
  webhooks: 'disabled' | 'ready'
  /** when Coolify last posted to `/app/hooks/coolify`, null if never */
  lastWebhookAt: string | null
}

/** One thing the dashboard is showing without a real source behind it. */
export interface DegradedNote {
  /** 'metrics' | 'uptime' | 'traffic' | 'deployments' | 'schedule' | 'backups' | … */
  scope: string
  reason: string
}

export interface OverviewResponse {
  generatedAt: string
  /** how long the SPA may reuse this payload, in ms (shortest cache TTL in play) */
  staleAfterMs: number
  dashboard: Dashboard
  notes: DegradedNote[]
}

/** What an action did upstream. Coolify answers 200 for all three. */
export type ActionOutcome =
  /** a deployment was created and is queued */
  | 'queued'
  /** accepted but nothing happened — same commit already queued, for instance */
  | 'skipped'
  /** applied immediately (stop, auto-deploy toggle, task execution) */
  | 'done'

export interface ActionResponse {
  outcome: ActionOutcome
  /** Coolify's own wording, safe to put straight in a toast */
  message: string
  /** the deployment this action created, when it created one */
  deploymentUuid?: string
}

export interface DeployRequest {
  /** application uuid */
  uuid: string
  /** rebuild without the layer cache */
  force?: boolean
}

export interface AutoDeployRequest {
  enabled: boolean
}

export type BffErrorCode =
  | 'not_configured'
  /** the *dashboard* has a password and this request carried no session */
  | 'unauthenticated'
  /** Coolify refused the BFF's token — not to be confused with the above */
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  /** the resource is not in a state where the action makes sense */
  | 'invalid_state'
  /** Coolify's deployment queue is full — retry later */
  | 'queue_full'
  | 'rate_limited'
  | 'upstream_unreachable'
  | 'upstream_error'
  | 'internal'

export interface BffErrorResponse {
  error: {
    code: BffErrorCode
    message: string
    /** actionable next step, safe to show in the UI */
    hint?: string
    retryAfterSeconds?: number
  }
}

/* ----------------------------------------------------- live channel ------ */

/** Colour of a pushed toast, resolved to a CSS variable by the SPA. */
export type ToastTone = 'info' | 'ok' | 'warn' | 'err'

/**
 * What the BFF pushes over `GET /app/events` (SSE, one unnamed `message` event
 * per item so the SPA needs a single listener).
 *
 * Two sources feed this: the adaptive poller and Coolify's outgoing webhooks.
 * They overlap on purpose — webhooks arrive first when they are configured, the
 * poller is the floor when they are not — so the hub deduplicates them.
 */
export type LiveEvent =
  /** first frame after connecting; also says what the channel cannot deliver */
  | { type: 'hello'; at: string; notes: DegradedNote[] }
  /** something upstream moved: refetch `/app/overview` */
  | { type: 'overview-changed'; at: string; reason: string }
  /**
   * New log lines for a running deployment. `from` is the index of `lines[0]`
   * in the whole log, which makes a replayed or duplicated frame harmless.
   */
  | { type: 'deployment-log'; at: string; deploymentId: string; from: number; lines: string[] }
  | {
      type: 'deployment-finished'
      at: string
      deploymentId: string
      app: string
      /** never `running` — this event is what ends it */
      state: DeploymentState
      message: string
    }
  /** anything else worth interrupting the user for (server down, backup failed…) */
  | { type: 'toast'; at: string; message: string; tone: ToastTone }

/** Answer of `POST /app/hooks/coolify`. Coolify ignores it; humans testing don't. */
export interface WebhookAck {
  ok: boolean
  /** false when the payload repeated one already handled (Coolify retries 5×) */
  accepted: boolean
  event?: string
}
