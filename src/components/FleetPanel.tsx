import type { CSSProperties } from 'react'
import { useState } from 'react'
import { source, type FleetTotals, type Server } from '../data'
import { useInterval } from '../hooks/useInterval'
import { Panel } from './Panel'
import './FleetPanel.css'

const METERS = [
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'MEM' },
  { key: 'dsk', label: 'DSK' },
] as const

/** `null` means Coolify has no metrics endpoint for this — an empty bar, not a zero. */
function Meter({ label, value }: { label: string; value: number | null }) {
  const unknown = value === null
  const warn = !unknown && value >= 80
  return (
    <div className={`meter${warn ? ' warn' : ''}${unknown ? ' meter--unknown' : ''}`}>
      <b>{label}</b>
      <div className="bar"><i style={{ transform: `scaleX(${unknown ? 0 : value / 100})` }} /></div>
      <span className="val num">{unknown ? '—' : `${Math.round(value)}%`}</span>
    </div>
  )
}

interface Props {
  servers: Server[]
  totals: FleetTotals
  index?: number
}

/** Meters drift every 2 s — each bar animates its own 700 ms transition. */
export function FleetPanel({ servers: initial, totals, index }: Props) {
  const [servers, setServers] = useState(initial)

  useInterval(() => {
    setServers(prev => prev.map(s => ({ ...s, metrics: source.sampleServer(s) })))
  }, 2000)

  const allReachable = servers.every(s => s.reachable)

  return (
    <Panel
      title="Fleet"
      label="Fleet"
      count={servers.length}
      index={index}
      meta={
        <>
          <span className="dot" style={{ '--c': allReachable ? 'var(--ok)' : 'var(--warn)' } as CSSProperties} />
          {allReachable ? 'all reachable' : 'degraded'}
        </>
      }
    >
      {servers.map(server => (
        <div className="srv" key={server.id}>
          <div className="l1">
            <span className="dot" style={{ '--c': server.reachable ? 'var(--ok)' : 'var(--err)' } as CSSProperties} />
            <span className="name">{server.name}</span>
            <span className="region">{server.region}</span>
            <span className="ping num">{server.pingMs === null ? '—' : `${server.pingMs} ms`}</span>
          </div>
          <div className="meters">
            {METERS.map(m => <Meter key={m.key} label={m.label} value={server.metrics[m.key]} />)}
          </div>
        </div>
      ))}
      <div className="fleet-foot">
        {totals.map(total => (
          <div key={total.id}><b className="num">{total.value}</b><span>{total.label}</span></div>
        ))}
      </div>
    </Panel>
  )
}
