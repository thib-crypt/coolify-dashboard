import { useEffect, useState } from 'react'
import type { Application } from '../data'
import { Panel } from './Panel'
import './AppsPanel.css'

interface Props {
  applications: Application[]
  count: number
  index?: number
  /** rejecting reverts the optimistic flip */
  onToggle: (app: Application, enabled: boolean) => void | Promise<unknown>
  onViewAll: (label: string) => void
}

export function AppsPanel({ applications: initial, count, index, onToggle, onViewAll }: Props) {
  const [apps, setApps] = useState(initial)

  // The local copy only exists to flip a toggle before the server has answered.
  // Everything else — uptime above all, which the BFF re-measures every minute —
  // comes from the payload, so a refreshed one replaces it wholesale.
  useEffect(() => { setApps(initial) }, [initial])

  const setAutoDeploy = (id: string, value: boolean | null) =>
    setApps(prev => prev.map(a => (a.id === id ? { ...a, autoDeploy: value } : a)))

  const toggle = async (app: Application) => {
    // unknown state: we do not know what we would be flipping away from
    if (app.autoDeploy === null) return
    const next = !app.autoDeploy
    setAutoDeploy(app.id, next)
    try {
      await onToggle(app, next)
    } catch {
      setAutoDeploy(app.id, app.autoDeploy)
    }
  }

  return (
    <Panel
      title="Applications"
      label="Applications"
      count={count}
      index={index}
      more={{ label: 'View all', onClick: onViewAll }}
    >
      {apps.map(app => (
        <div className="approw" key={app.id}>
          <span className="appic" style={{ background: app.gradient }}>{app.initial}</span>
          <div className="id">
            <div className="an">{app.name}</div>
            <div className="ad">{app.domain}</div>
          </div>
          <span className="up" title={app.uptime ? 'Measured by this dashboard over the last 24 h' : 'Not probed — no public domain, or probing is off'}>
            {app.uptime ?? '—'}
          </span>
          <div className="auto">
            auto deploy
            {app.autoDeploy === null ? (
              <span className="tgl tgl--unknown" title="Coolify did not return this application's settings">—</span>
            ) : (
              <button
                className="tgl"
                role="switch"
                aria-checked={app.autoDeploy}
                aria-label={`Auto deploy ${app.name}`}
                onClick={() => { void toggle(app) }}
              />
            )}
          </div>
        </div>
      ))}
    </Panel>
  )
}
