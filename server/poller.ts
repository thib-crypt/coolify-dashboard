/**
 * Adaptive polling loop (phase 3 of PLAN.md).
 *
 * Coolify has no push channel a third party can use: `POST /broadcasting/auth`
 * is session-authenticated and outside the CORS paths, and **no deployment
 * progress event is broadcast at all** — Coolify's own UI polls its Livewire
 * components every two seconds. So the BFF polls too, once for every browser
 * watching, and pushes what it finds over SSE.
 *
 * Three things keep that honest:
 *
 *  - **It stops when nobody is watching.** The hub reports the 0 → 1 and 1 → 0
 *    subscriber transitions; with no SSE client there is nothing to push to and
 *    `/app/overview` refreshes its own cache anyway.
 *  - **It adapts.** 2.5 s while a deployment is running (24 req/min), 4 s
 *    otherwise (15 req/min) — annexe B of PLAN.md budgets 200 req/min *per user*,
 *    and this is the only poller left, see the cadence constants below.
 *  - **It reads `/deployments` only.** That list already carries `logs` when the
 *    token has `read:sensitive` (`DeployController::removeSensitiveData`), so
 *    polling each running deployment separately would double the cost for no new
 *    information. The one extra call is `GET /deployments/{uuid}` when a
 *    deployment *leaves* the list: the list is `queued`/`in_progress` only, so a
 *    build that just ended is invisible there and its outcome has to be asked for.
 */

import type { LiveEvent } from '../shared/bff'
import type { DeploymentState } from '../shared/dashboard'
import type * as Api from '../shared/coolify-api'
import type { TtlCache } from './cache'
import type { CoolifyClient } from './coolify/client'
import { mapDeploymentState, parseDeploymentLogs } from './coolify/mappers'
import { deploymentFinishedKey, type EventHub } from './events'
import { describeError } from './overview'

/**
 * Cadences, overridable so tests do not wait on wall-clock time.
 *
 * The idle one is not a comfort setting: **Coolify emits no webhook when a
 * deployment starts** (the notification classes cover success, failure, status,
 * backups, tasks and servers — nothing for a build beginning). So this interval
 * *is* how long a deployment launched from Coolify's own UI stays invisible
 * here, and PLAN.md asks for under five seconds.
 *
 * That is still cheaper than annexe B budgeted. Annexe B assumed two pollers —
 * `/deployments` at 3 s plus `/deployments/{uuid}` at 2.5 s for the live log,
 * 44 req/min together. One list call serves both purposes, so the ceiling here
 * is 24 req/min while building and 15 req/min at rest — and zero with no
 * browser watching.
 */
export const POLL_ACTIVE_MS = 2_500
export const POLL_IDLE_MS = 4_000
/** Ceiling for the exponential back-off while upstream is failing. */
export const POLL_MAX_BACKOFF_MS = 60_000
/**
 * A first frame for a deployment already halfway through its build could carry
 * thousands of lines. The ticker shows one line at a time — the tail is what
 * matters, and `from` keeps the SPA's indices straight despite the truncation.
 */
export const MAX_LOG_LINES_PER_EVENT = 200

/** What the poller remembers between two ticks about one running deployment. */
interface Tracked {
  app: string
  /** how many parsed log lines have already been pushed */
  published: number
}

export interface PollerDeps {
  client: CoolifyClient
  cache: TtlCache
  hub: EventHub
  activeMs?: number
  idleMs?: number
  now?: () => number
  /** injected in tests; defaults to the global timers */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface Poller {
  start(): void
  stop(): void
  /** Runs a tick now — used by the webhook receiver, which knows before we do. */
  poke(): void
  readonly state: 'stopped' | 'idle' | 'active'
}

export function createPoller(deps: PollerDeps): Poller {
  const { client, cache, hub } = deps
  const activeMs = deps.activeMs ?? POLL_ACTIVE_MS
  const idleMs = deps.idleMs ?? POLL_IDLE_MS
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout))

  let running = false
  let active = false
  let timer: unknown = null
  let inFlight: Promise<void> | null = null
  let failures = 0
  /** so the "upstream is down" toast fires on the transition, not every tick */
  let reportedFailure = false

  const tracked = new Map<string, Tracked>()

  const at = () => new Date(now()).toISOString()
  const emit = (event: LiveEvent, key?: string) => hub.publish(event, key)
  const changed = (reason: string) => emit({ type: 'overview-changed', at: at(), reason })

  /** Forces a load and stores it, so `/app/overview` reads a warm cache. */
  const refresh = <T>(key: string, loader: () => Promise<T>) => cache.fetch(key, 0, loader)

  function schedule(): void {
    if (!running) return
    const base = active ? activeMs : idleMs
    // Back off while upstream is failing rather than hammering a rate limiter.
    const delay = failures === 0 ? base : Math.min(idleMs * 2 ** failures, POLL_MAX_BACKOFF_MS)
    timer = setTimer(run, delay)
  }

  /** Pushes whatever `parsed` added since the last frame for this deployment. */
  function publishLogs(deploymentUuid: string, entry: Tracked, parsed: string[]): void {
    if (parsed.length <= entry.published) return
    const lines = parsed.slice(entry.published).slice(-MAX_LOG_LINES_PER_EVENT)
    emit({
      type: 'deployment-log',
      at: at(),
      deploymentId: deploymentUuid,
      from: parsed.length - lines.length,
      lines,
    })
    entry.published = parsed.length
  }

  /**
   * A deployment left `/deployments`, so it ended. Ask for its terminal status,
   * push the tail of its log, and announce the outcome — keyed so the webhook
   * receiver and this loop never toast the same finish twice.
   */
  async function reportFinished(deploymentUuid: string, entry: Tracked): Promise<void> {
    let final: Api.ApplicationDeploymentQueue | null = null
    try {
      // Straight to the client: a finished deployment never changes again, so
      // caching it would only leak a key nothing ever invalidates.
      final = await client.deployment(deploymentUuid)
    } catch (error) {
      // Deleted, or another team's: the row is gone either way, so the panel
      // still needs refreshing — we just cannot say how it ended.
      console.error(`[poller] could not read deployment ${deploymentUuid}: ${describeError(error)}`)
    }

    if (final) {
      publishLogs(deploymentUuid, entry, parseDeploymentLogs(final.logs))
      const state = mapDeploymentState(final.status)
      emit(
        {
          type: 'deployment-finished',
          at: at(),
          deploymentId: deploymentUuid,
          app: final.application_name ?? entry.app,
          state,
          message: outcomeMessage(final.application_name ?? entry.app, state),
        },
        deploymentFinishedKey(deploymentUuid),
      )
    }
  }

  async function tick(): Promise<void> {
    if (!running) return
    timer = null

    let deployments: Api.ApplicationDeploymentQueue[]
    try {
      deployments = (await refresh('deployments:running', () => client.runningDeployments())).value
      if (reportedFailure) {
        reportedFailure = false
        emit({ type: 'toast', at: at(), message: 'Reconnected to Coolify.', tone: 'ok' })
        changed('upstream recovered')
      }
      failures = 0
    } catch (error) {
      failures++
      const reason = describeError(error)
      console.error(`[poller] ${reason}`)
      if (!reportedFailure) {
        reportedFailure = true
        emit({ type: 'toast', at: at(), message: `Live updates paused — ${reason}`, tone: 'err' })
      }
      schedule()
      return
    }

    const live = new Set<string>()
    let started = 0

    for (const deployment of deployments) {
      const uuid = deployment.deployment_uuid
      if (!uuid) continue
      live.add(uuid)

      let entry = tracked.get(uuid)
      if (!entry) {
        entry = { app: deployment.application_name ?? 'unknown', published: 0 }
        tracked.set(uuid, entry)
        started++
      }
      publishLogs(uuid, entry, parseDeploymentLogs(deployment.logs))
    }

    const finished = [...tracked].filter(([uuid]) => !live.has(uuid))
    for (const [uuid] of finished) tracked.delete(uuid)

    // The panel has to change either way: a row appeared, or one left it.
    if (started > 0) changed(`${started} deployment(s) started`)
    if (finished.length > 0) {
      await Promise.all(finished.map(([uuid, entry]) => reportFinished(uuid, entry)))
      // After the terminal read, so the refetched overview already sees the
      // deployment in its application's history rather than in limbo.
      changed(`${finished.length} deployment(s) finished`)
    }

    active = live.size > 0
    schedule()
  }

  function run(): void {
    if (inFlight) return
    inFlight = tick().finally(() => {
      inFlight = null
    })
  }

  return {
    start() {
      if (running) return
      running = true
      failures = 0
      run()
    },

    stop() {
      running = false
      active = false
      if (timer !== null) clearTimer(timer)
      timer = null
      // Nothing was published while stopped, so the next start must re-announce
      // the logs of anything still building rather than assume the SPA has them.
      tracked.clear()
    },

    poke() {
      if (!running) return
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      run()
    },

    get state() {
      if (!running) return 'stopped'
      return active ? 'active' : 'idle'
    },
  }
}

/** Coolify says nothing on a finish; this is the BFF's own wording. */
export function outcomeMessage(app: string, state: DeploymentState): string {
  switch (state) {
    case 'success':
      return `${app} deployed`
    case 'failed':
      return `${app} — deployment failed`
    case 'cancelled':
      return `${app} — deployment cancelled`
    default:
      return `${app} — deployment ended`
  }
}
