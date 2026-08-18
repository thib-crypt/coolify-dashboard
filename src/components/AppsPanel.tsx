import { useState } from 'react'
import type { Application } from '../data'
import { Panel } from './Panel'
import './AppsPanel.css'

interface Props {
  applications: Application[]
  count: number
  index?: number
  onToggle: (app: Application, enabled: boolean) => void
  onViewAll: (label: string) => void
}

export function AppsPanel({ applications: initial, count, index, onToggle, onViewAll }: Props) {
  const [apps, setApps] = useState(initial)

  const toggle = (app: Application) => {
    const next = !app.autoDeploy
    setApps(prev => prev.map(a => (a.id === app.id ? { ...a, autoDeploy: next } : a)))
    onToggle(app, next)
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
          <span className="up">{app.uptime}</span>
          <div className="auto">
            auto deploy
            <button
              className="tgl"
              role="switch"
              aria-checked={app.autoDeploy}
              aria-label={`Auto deploy ${app.name}`}
              onClick={() => toggle(app)}
            />
          </div>
        </div>
      ))}
    </Panel>
  )
}
