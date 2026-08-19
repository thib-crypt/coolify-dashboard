import { useCallback, useEffect, useRef, useState } from 'react'
import { DashboardError, source, type ActionOutcome, type ActionResponse, type PaletteAction } from './data'
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
import { useLiveDashboard } from './hooks/useLiveDashboard'
import { useToast } from './hooks/useToasts'

export default function App() {
  const { toast } = useToast()
  // The hook owns the payload, the SSE channel and the fallback poll: this
  // component only reacts to what it publishes.
  const { data, error, setEnvironment, reload, connected, logs, awaitDeployment } = useLiveDashboard()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const searchRef = useRef<HTMLButtonElement>(null)

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
  ): Promise<ActionResponse> => {
    try {
      const result = await action()
      announce(result)
      // A push will say so too, but only once Coolify has caught up; refreshing
      // here is what makes the click feel immediate.
      if (options.refresh) reload()
      return result
    } catch (cause) {
      report(cause, failure)
      throw cause
    }
  }

  /**
   * Deploy, then keep the caller busy until Coolify has finished building.
   *
   * The Deploy button's "Deploying" face lasts exactly as long as the promise
   * it was handed — before phase 3 that was the length of the HTTP request,
   * which is a few hundred milliseconds of a build that takes minutes. Now the
   * live channel says when the deployment actually ended, so the button waits
   * for that instead. A skipped deploy has no deployment to wait for.
   */
  const deployAndWatch = async (appId: string, name: string) => {
    const result = await runAction(`Could not deploy ${name}`, () => source.triggerDeploy(appId), {
      refresh: true,
    })
    if (result.deploymentUuid) await awaitDeployment(result.deploymentUuid)
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

  if (error && !data) {
    return (
      <LoadError
        message={error.message}
        {...(error.hint ? { hint: error.hint } : {})}
        onRetry={reload}
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
              return deployAndWatch(target.id, target.name)
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
                logs={logs}
                streaming={connected}
                onCancel={async d => {
                  await runAction(`Could not cancel ${d.app}`, () => source.cancelDeployment(d.id), {
                    refresh: true,
                  })
                }}
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
