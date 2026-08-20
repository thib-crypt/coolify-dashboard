import { AppsPanel } from '../components/AppsPanel'
import { DeploymentsPanel } from '../components/DeploymentsPanel'
import { FleetPanel } from '../components/FleetPanel'
import { InsightsPanel } from '../components/InsightsPanel'
import { KpiGrid } from '../components/KpiGrid'
import { PageHead } from '../components/PageHead'
import { SchedulePanel } from '../components/SchedulePanel'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useShell } from '../layout/context'

/** Everything at a glance; each panel links to the page that holds the rest. */
export function Overview() {
  useDocumentTitle('Overview')

  const { data, connected, logs, actions } = useShell()

  return (
    <>
      <PageHead index={0} />
      <KpiGrid kpis={data.kpis} index={1} />

      <div className="grid-2">
        <DeploymentsPanel
          deployments={data.deployments}
          count={data.deploymentCount}
          index={2}
          logs={logs}
          streaming={connected}
          onCancel={async d => { await actions.cancel(d.id, d.app) }}
        />
        <FleetPanel servers={data.servers} totals={data.fleetTotals} index={3} />
      </div>

      <div className="grid-2b">
        <InsightsPanel insights={data.insights} index={4} />
        <AppsPanel
          applications={data.applications}
          count={data.applicationCount}
          index={5}
          onToggle={(app, enabled) => actions.setAutoDeploy(app.id, app.name, enabled)}
        />
      </div>

      <SchedulePanel timeline={data.timeline} index={6} />
    </>
  )
}
