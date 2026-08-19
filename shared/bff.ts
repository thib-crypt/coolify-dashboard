/** Contract between the React SPA and this repo's BFF (`/app/*`).
    The browser never talks to Coolify: it only ever sees these shapes. */

import type { Dashboard } from './dashboard'

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
