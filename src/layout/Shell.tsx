import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router'
import { CommandPalette } from '../components/CommandPalette'
import { LoadError } from '../components/LoadError'
import { PulseStrip } from '../components/PulseStrip'
import { Rail } from '../components/Rail'
import { Setup } from '../components/Setup'
import { Toasts } from '../components/Toasts'
import { Topbar } from '../components/Topbar'
import { useActions } from '../hooks/useActions'
import { useLiveDashboard } from '../hooks/useLiveDashboard'
import type { ShellContext } from './context'

/**
 * The layout route: everything that must exist once, whatever page is open.
 *
 * One `useLiveDashboard` for the whole application, so the SSE stream survives
 * navigation and a page change costs zero requests — which also keeps the
 * BFF's upstream budget flat no matter how much someone clicks around
 * (docs/roadmap.md, appendix B).
 */
export function Shell({ onSignOut }: { onSignOut?: () => void }) {
  const { data, error, setEnvironment, reload, connected, logs, awaitDeployment } = useLiveDashboard()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const searchRef = useRef<HTMLButtonElement>(null)

  const actions = useActions({
    reload,
    awaitDeployment,
    nameOf: id => data?.applications.find(app => app.id === id)?.name ?? id,
    onSwitchEnvironment: () => {
      // The environment switch is a segmented control: step to the next one.
      const list = data?.environments ?? []
      const next = list[(list.indexOf(data?.environment ?? '') + 1) % (list.length || 1)]
      if (next && next !== data?.environment) setEnvironment(next)
      else actions.say('Only one environment in this team')
    },
  })

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

  // With nothing configured there is nothing else to show and only one thing to
  // do, so the check takes the screen rather than hiding behind a button.
  if (setupOpen || (error && !data && error.code === 'not_configured')) {
    return <Setup onClose={() => setSetupOpen(false)} onRetry={reload} />
  }

  if (error && !data) {
    return (
      <LoadError
        message={error.message}
        {...(error.hint ? { hint: error.hint } : {})}
        onRetry={reload}
        onRunSetup={() => setSetupOpen(true)}
      />
    )
  }

  if (!data) return null

  const context: ShellContext = { data, reload, connected, logs, actions }

  return (
    <>
      <div className="shell">
        <Rail />

        <div className="main">
          <Topbar
            org={data.org}
            environments={data.environments}
            environment={data.environment}
            onEnvironmentChange={setEnvironment}
            systemStatus={data.systemStatus}
            searchRef={searchRef}
            {...(onSignOut ? { onSignOut } : {})}
            onOpenPalette={() => setPaletteOpen(true)}
            onDeploy={() => {
              const target = data.applications[0]
              if (!target) {
                actions.say('No application to deploy', 'err')
                return Promise.reject(new Error('No application to deploy'))
              }
              return actions.deployAndWatch(target.id, target.name)
            }}
          />

          <PulseStrip />

          <main className="content">
            {/* Keyed by environment: switching it replaces the data underneath,
                and panels that animate their own entrance should replay it. */}
            <Outlet key={data.environment} context={context} />
          </main>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        actions={data.paletteActions}
        onClose={closePalette}
        onRun={action => { void actions.runCommand(action).catch(() => {}) }}
      />
      <Toasts />
    </>
  )
}
