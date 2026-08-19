import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DashboardError,
  source,
  type ActionOutcome,
  type ActionResponse,
  type Dashboard,
  type EnvironmentName,
  type PaletteAction,
} from './data'
import { AppsPanel } from './components/AppsPanel'
import { CommandPalette } from './components/CommandPalette'
import { DeploymentsPanel } from './components/DeploymentsPanel'
import { FleetPanel } from './components/FleetPanel'
import { InsightsPanel } from './components/InsightsPanel'
import { KpiGrid } from './components/KpiGrid'
import { LoadError } from './components/LoadError'
import { PageHead } from './components/PageHead'
import { PulseStrip } from './components/PulseStrip'
import { Rail } from './components/Rail'
import { SchedulePanel } from './components/SchedulePanel'
import { Toasts } from './components/Toasts'
import { Topbar } from './components/Topbar'
import { useToast } from './hooks/useToasts'

export default function App() {
  const { toast } = useToast()
  // null until the first payload arrives: the source decides the default environment
  const [environment, setEnvironment] = useState<EnvironmentName | null>(null)
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState<DashboardError | null>(null)
  const [reloads, setReloads] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const searchRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    source.getDashboard(environment).then(
      dashboard => {
        if (!alive) return
        setData(dashboard)
        setError(null)
      },
      cause => {
        if (!alive) return
        setError(
          cause instanceof DashboardError
            ? cause
            : new DashboardError('internal', cause instanceof Error ? cause.message : String(cause)),
        )
      },
    )
    return () => { alive = false }
  }, [environment, reloads])

  const closePalette = useCallback(() => {
    setPaletteOpen(false)
    searchRef.current?.focus({ preventScroll: true })
  }, [])

  // ⌘K / Ctrl+K toggles the palette from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (paletteOpen) closePalette()
        else setPaletteOpen(true)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [paletteOpen, closePalette])

  const quietAction = (label: string) => toast(`Opening — ${label}`, 'var(--t3)')

  /** Coolify's own wording, coloured by what it actually did. */
  const announce = (result: ActionResponse) => {
    const colors: Record<ActionOutcome, string> = {
      queued: 'var(--accent)',
      done: 'var(--ok)',
      skipped: 'var(--warn)',
    }
    toast(result.message, colors[result.outcome])
  }

  /** The BFF already phrased the failure and its remedy; both belong on screen. */
  const report = (cause: unknown, fallback: string) => {
    if (!(cause instanceof DashboardError)) {
      toast(cause instanceof Error ? `${fallback} — ${cause.message}` : fallback, 'var(--err)')
      return
    }
    const retry = cause.retryAfterSeconds ? ` Retry in ${cause.retryAfterSeconds}s.` : ''
    toast(`${cause.message}${retry}${cause.hint ? ` ${cause.hint}` : ''}`, 'var(--err)')
  }

  /** Every action funnels through here: one toast, one refresh, one error path. */
  const runAction = async (
    failure: string,
    action: () => Promise<ActionResponse>,
    options: { refresh?: boolean } = {},
  ) => {
    try {
      announce(await action())
      if (options.refresh) setReloads(n => n + 1)
    } catch (cause) {
      report(cause, failure)
      throw cause
    }
  }

  const nameOf = (id: string) => data?.applications.find(app => app.id === id)?.name ?? id

  const runCommand = (action: PaletteAction) => {
    const command = action.command
    switch (command.kind) {
      case 'deploy':
        return runAction(
          `Could not deploy ${nameOf(command.application)}`,
          () => source.triggerDeploy(command.application),
          { refresh: true },
        )
      case 'restart':
        return runAction(
          `Could not restart ${nameOf(command.application)}`,
          () => source.restartApplication(command.application),
          { refresh: true },
        )
      case 'stop':
        return runAction(
          `Could not stop ${nameOf(command.application)}`,
          () => source.stopApplication(command.application),
          { refresh: true },
        )
      case 'run-task':
        return runAction(`Could not run ${action.title}`, () =>
          source.runScheduledTask(command.owner, command.ownerId, command.task),
        )
      case 'ui': {
        // the environment switch is a segmented control: step to the next one
        const list = data?.environments ?? []
        const next = list[(list.indexOf(data?.environment ?? '') + 1) % (list.length || 1)]
        if (next && next !== data?.environment) setEnvironment(next)
        else toast('Only one environment in this team', 'var(--t3)')
        return Promise.resolve()
      }
    }
  }

  if (error) {
    return (
      <LoadError
        message={error.message}
        {...(error.hint ? { hint: error.hint } : {})}
        onRetry={() => { setError(null); setReloads(n => n + 1) }}
      />
    )
  }

  if (!data) return null

  return (
    <>
      <div className="shell">
        <Rail current="overview" />

        <div className="main">
          <Topbar
            org={data.org}
            environments={data.environments}
            environment={data.environment}
            onEnvironmentChange={setEnvironment}
            systemStatus={data.systemStatus}
            searchRef={searchRef}
            onOpenPalette={() => setPaletteOpen(true)}
            onDeploy={() => {
              const target = data.applications[0]
              if (!target) {
                toast('No application to deploy', 'var(--t3)')
                return Promise.reject(new Error('No application to deploy'))
              }
              return runAction(
                `Could not deploy ${target.name}`,
                () => source.triggerDeploy(target.id),
                { refresh: true },
              )
            }}
          />

          <PulseStrip />

          <main className="content">
            <PageHead index={0} />
            <KpiGrid kpis={data.kpis} index={1} />

            <div className="grid-2">
              <DeploymentsPanel
                deployments={data.deployments}
                count={data.deploymentCount}
                index={2}
                onCancel={d =>
                  runAction(`Could not cancel ${d.app}`, () => source.cancelDeployment(d.id), {
                    refresh: true,
                  })
                }
                onViewAll={quietAction}
              />
              {/* keyed by environment: these panels hold their own copy of the data */}
              <FleetPanel key={data.environment} servers={data.servers} totals={data.fleetTotals} index={3} />
            </div>

            <div className="grid-2b">
              <InsightsPanel insights={data.insights} index={4} onAction={quietAction} />
              <AppsPanel
                key={data.environment}
                applications={data.applications}
                count={data.applicationCount}
                index={5}
                onToggle={(app, enabled) =>
                  runAction(`Could not change auto-deploy for ${app.name}`, () =>
                    source.setAutoDeploy(app.id, enabled),
                  )
                }
                onViewAll={quietAction}
              />
            </div>

            <SchedulePanel timeline={data.timeline} index={6} />
          </main>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        actions={data.paletteActions}
        onClose={closePalette}
        onRun={action => { void runCommand(action).catch(() => {}) }}
      />
      <Toasts />
    </>
  )
}
