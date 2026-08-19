/** Contract between the React SPA and this repo's BFF (`/app/*`).
    The browser never talks to Coolify: it only ever sees these shapes. */

import type { Dashboard, DeploymentState } from './dashboard'

export interface HealthResponse {
  ok: boolean
  service: 'coolify-dashboard-bff'
  now: string
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
