import { useCallback, useEffect, useRef, useState } from 'react'
import { DashboardError, source, type Dashboard, type EnvironmentName, type LiveUpdate } from '../data'
import { useToast } from './useToasts'

/**
 * Owns the dashboard payload and the live channel (phase 3 of PLAN.md).
 *
 * The BFF pushes over SSE, but the dashboard must not *depend* on that: a proxy
 * that buffers `text/event-stream`, a corporate filter, a sleeping laptop — all
 * of them break the stream without breaking the app. So there are two paths and
 * they agree:
 *
 *  - **push**: `overview-changed` schedules a refetch, `deployment-log` extends
 *    the ticker, `deployment-finished` toasts the outcome;
 *  - **poll**: a slow interval that refetches anyway — every minute while the
 *    stream is up, every ten seconds when it is not.
 *
 * Refetches are coalesced and never overlap, so a burst of webhooks costs one
 * request, not one per event.
 */

/** Wait this long after a push before refetching: bursts arrive together. */
const COALESCE_MS = 250
const POLL_WHEN_CONNECTED_MS = 60_000
const POLL_WHEN_OFFLINE_MS = 10_000
/** A deployment we never saw running was skipped or instant — stop waiting. */
const UNSEEN_GRACE_MS = 20_000
/** Nothing waits on a build forever, whatever the channel does. */
const MAX_WAIT_MS = 15 * 60_000

/** Live log lines of a running deployment, keyed by deployment id. */
export type DeploymentLogs = Record<string, string[]>

interface Waiter {
  resolve: () => void
  /** flips once the deployment has been seen in the running set */
  sawRunning: boolean
  expiresAt: number
}

export interface LiveDashboard {
  data: Dashboard | null
  error: DashboardError | null
  environment: EnvironmentName | null
  setEnvironment: (env: EnvironmentName) => void
  reload: () => void
  /** true while the push channel is up — the log ticker streams instead of looping */
  connected: boolean
  logs: DeploymentLogs
  /** Resolves once `deploymentUuid` has stopped running (or the wait times out). */
  awaitDeployment: (deploymentUuid: string) => Promise<void>
}

const TONES: Record<string, string> = {
  info: 'var(--t3)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  err: 'var(--err)',
}

export function useLiveDashboard(): LiveDashboard {
  const { toast } = useToast()
  // null until the first payload arrives: the source picks the default environment
  const [environment, setEnvironment] = useState<EnvironmentName | null>(null)
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState<DashboardError | null>(null)
  const [connected, setConnected] = useState(false)
  const [logs, setLogs] = useState<DeploymentLogs>({})

  const waiters = useRef(new Map<string, Waiter>())
  // Read inside callbacks that must not be re-created on every environment change.
  const requestedEnv = useRef<EnvironmentName | null>(null)
  requestedEnv.current = environment

  const mounted = useRef(true)
  const fetching = useRef(false)
  /** set when a push lands mid-flight: the answer in flight is already stale */
  const refetchQueued = useRef(false)
  const coalesce = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Resolves the waiters whose deployment is done, gone, or overdue. */
  const settleWaiters = useCallback((running: Set<string>) => {
    const now = Date.now()
    for (const [id, waiter] of waiters.current) {
      if (running.has(id)) {
        if (!waiter.sawRunning) {
          waiter.sawRunning = true
          waiter.expiresAt = now + MAX_WAIT_MS
        }
        continue
      }
      if (!waiter.sawRunning && now < waiter.expiresAt) continue
      waiters.current.delete(id)
      waiter.resolve()
    }
  }, [])

  /**
   * Applies a fresh payload: seeds the ticker for deployments we have no live
   * lines for, forgets the ones that finished, and releases anything waiting.
   */
  const apply = useCallback(
    (dashboard: Dashboard) => {
      setData(dashboard)
      setError(null)

      const running = new Set(dashboard.deployments.filter(d => d.state === 'running').map(d => d.id))
      setLogs(previous => {
        const next: DeploymentLogs = {}
        let changed = false
        for (const deployment of dashboard.deployments) {
          if (deployment.state !== 'running') continue
          const live = previous[deployment.id] ?? []
          // The payload's log and the pushed frames index the same array, so the
          // longer of the two is simply the more complete one.
          const seed = deployment.logs ?? []
          next[deployment.id] = seed.length > live.length ? seed : live
          if (next[deployment.id] !== previous[deployment.id]) changed = true
        }
        // Anything not running any more is gone from `next`; that is the pruning.
        if (!changed && Object.keys(next).length === Object.keys(previous).length) return previous
        return next
      })

      settleWaiters(running)
    },
    [settleWaiters],
  )

  const load = useCallback(async () => {
    if (fetching.current) {
      refetchQueued.current = true
      return
    }
    fetching.current = true
    // The environment can change mid-flight; an answer for the previous one
    // would repaint the whole dashboard with the wrong resources.
    const env = requestedEnv.current
    const current = () => mounted.current && requestedEnv.current === env

    try {
      const dashboard = await source.getDashboard(env)
      if (current()) apply(dashboard)
      else if (mounted.current) refetchQueued.current = true
    } catch (cause) {
      if (current()) {
        setError(
          cause instanceof DashboardError
            ? cause
            : new DashboardError('internal', cause instanceof Error ? cause.message : String(cause)),
        )
      }
    } finally {
      fetching.current = false
      if (refetchQueued.current && mounted.current) {
        refetchQueued.current = false
        void load()
      }
    }
  }, [apply])

  /** One refetch for a burst of pushes, instead of one per event. */
  const scheduleReload = useCallback(() => {
    if (coalesce.current) clearTimeout(coalesce.current)
    coalesce.current = setTimeout(() => {
      coalesce.current = null
      void load()
    }, COALESCE_MS)
  }, [load])

  const reload = useCallback(() => {
    setError(null)
    void load()
  }, [load])

  // Declared before the loaders: they check this flag before touching state.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /* --- first load, and every environment change ------------------------- */
  useEffect(() => {
    void load()
  }, [load, environment])

  /* --- the push channel -------------------------------------------------- */
  useEffect(() => {
    const handle = (update: LiveUpdate) => {
      switch (update.type) {
        case 'hello':
          setConnected(true)
          // Nothing renders these yet; they say what the channel cannot deliver.
          for (const note of update.notes) console.info(`[live] ${note.scope}: ${note.reason}`)
          // The stream may have been down long enough for the payload to drift.
          scheduleReload()
          break

        case 'offline':
          setConnected(false)
          break

        case 'overview-changed':
          scheduleReload()
          break

        case 'deployment-log': {
          const { deploymentId, from, lines } = update
          setLogs(previous => {
            const existing = previous[deploymentId] ?? []
            // `from` past what we hold means the frame beat the first payload for
            // a build already thousands of lines in. Anchor on the tail instead
            // of inventing the history: `/app/overview` brings the rest, and
            // `apply` keeps whichever array is longer, which realigns the indices.
            if (existing.length < from) return { ...previous, [deploymentId]: lines }
            return { ...previous, [deploymentId]: [...existing.slice(0, from), ...lines] }
          })
          break
        }

        case 'deployment-finished': {
          const tone = update.state === 'success' ? 'ok' : update.state === 'failed' ? 'err' : 'warn'
          toast(update.message, TONES[tone] as string)
          waiters.current.get(update.deploymentId)?.resolve()
          waiters.current.delete(update.deploymentId)
          scheduleReload()
          break
        }

        case 'toast':
          toast(update.message, TONES[update.tone] ?? TONES.info!)
          break
      }
    }

    const unsubscribe = source.subscribe(handle)
    return () => {
      unsubscribe()
      setConnected(false)
    }
  }, [scheduleReload, toast])

  /* --- the safety net ---------------------------------------------------- */
  useEffect(() => {
    const every = connected ? POLL_WHEN_CONNECTED_MS : POLL_WHEN_OFFLINE_MS
    const id = setInterval(() => void load(), every)
    return () => clearInterval(id)
  }, [connected, load])

  useEffect(
    () => () => {
      if (coalesce.current) clearTimeout(coalesce.current)
      // A pending Deploy button must not stay busy forever after an unmount.
      for (const waiter of waiters.current.values()) waiter.resolve()
      waiters.current.clear()
    },
    [],
  )

  const awaitDeployment = useCallback(
    (deploymentUuid: string) =>
      new Promise<void>(resolve => {
        const existing = waiters.current.get(deploymentUuid)
        if (existing) {
          const previous = existing.resolve
          existing.resolve = () => {
            previous()
            resolve()
          }
          return
        }
        waiters.current.set(deploymentUuid, {
          resolve,
          sawRunning: false,
          expiresAt: Date.now() + UNSEEN_GRACE_MS,
        })
      }),
    [],
  )

  return { data, error, environment, setEnvironment, reload, connected, logs, awaitDeployment }
}
