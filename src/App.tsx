import { useCallback, useEffect, useRef, useState } from 'react'
import { source, type Dashboard, type EnvironmentName, type PaletteAction } from './data'
import { AppsPanel } from './components/AppsPanel'
import { CommandPalette } from './components/CommandPalette'
import { DeploymentsPanel } from './components/DeploymentsPanel'
import { FleetPanel } from './components/FleetPanel'
import { InsightsPanel } from './components/InsightsPanel'
import { KpiGrid } from './components/KpiGrid'
import { PageHead } from './components/PageHead'
import { PulseStrip } from './components/PulseStrip'
import { Rail } from './components/Rail'
import { SchedulePanel } from './components/SchedulePanel'
import { Toasts } from './components/Toasts'
import { Topbar } from './components/Topbar'
import { useToast } from './hooks/useToasts'

export default function App() {
  const { toast } = useToast()
  const [environment, setEnvironment] = useState<EnvironmentName>('Production')
  const [data, setData] = useState<Dashboard | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const searchRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    source.getDashboard(environment).then(d => { if (alive) setData(d) })
    return () => { alive = false }
  }, [environment])

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

  const runAction = (action: PaletteAction) => {
    toast(`Running — ${action.title}`, 'var(--accent)')
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
            environment={environment}
            onEnvironmentChange={setEnvironment}
            systemStatus={data.systemStatus}
            searchRef={searchRef}
            onOpenPalette={() => setPaletteOpen(true)}
            onDeploy={() => {
              const target = data.deployments.find(d => d.state === 'running')?.app ?? data.applications[0]?.name
              void source.triggerDeploy(target)
              toast(`Deployment queued — ${target} @ main`, 'var(--accent)')
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
                onCancel={d => {
                  void source.cancelDeployment(d.id)
                  toast(`Deployment cancelled — ${d.app}`, 'var(--err)')
                }}
                onViewAll={quietAction}
              />
              <FleetPanel servers={data.servers} totals={data.fleetTotals} index={3} />
            </div>

            <div className="grid-2b">
              <InsightsPanel insights={data.insights} index={4} onAction={quietAction} />
              <AppsPanel
                applications={data.applications}
                count={data.applicationCount}
                index={5}
                onToggle={(app, enabled) => { void source.setAutoDeploy(app.id, enabled) }}
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
        onRun={runAction}
      />
      <Toasts />
    </>
  )
}
