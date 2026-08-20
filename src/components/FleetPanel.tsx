import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { source, type FleetTotals, type Server } from '../data'
import { useInterval } from '../hooks/useInterval'
import { Panel } from './Panel'
import './FleetPanel.css'

const METERS = [
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'MEM' },
  { key: 'dsk', label: 'DSK' },
] as const

/**
 * `null` means nothing measured this — an empty bar, never a zero.
 *
 * The reason travels with the value: Coolify publishes no CPU/RAM endpoint, so
 * an empty gauge is the *normal* state until an SSH key reaches the BFF, and
 * "we were never given a way to read this" has to be distinguishable from
 * "the agent is down" without leaving the panel.
 */
function Meter({ label, value, reason }: { label: string; value: number | null; reason?: string }) {
  const unknown = value === null
  const warn = !unknown && value >= 80
  return (
    <div className={`meter${warn ? ' warn' : ''}${unknown ? ' meter--unknown' : ''}`} title={unknown ? reason : undefined}>
      <b>{label}</b>
      <div className="bar"><i style={{ transform: `scaleX(${unknown ? 0 : value / 100})` }} /></div>
      <span className="val num">{unknown ? '—' : `${Math.round(value)}%`}</span>
    </div>
  )
}

/** The disk gauge has its own source — a webhook — and so its own explanation. */
const DISK_NOTE =
  'Coolify only reports disk usage in its high-disk-usage webhook, so this fills in when an alert is raised.'

interface Props {
  servers: Server[]
  totals: FleetTotals
  index?: number
}

/** Meters drift every 2 s — each bar animates its own 700 ms transition. */
export function FleetPanel({ servers: initial, totals, index }: Props) {
  const [servers, setServers] = useState(initial)

  // A refreshed payload wins over the sampled copy: ping and disk are measured
  // upstream now, and only the mock has anything to drift between two loads.
  useEffect(() => { setServers(initial) }, [initial])

  useInterval(() => {
    setServers(prev => prev.map(s => ({ ...s, metrics: source.sampleServer(s) })))
  }, 2000)

  const allReachable = servers.every(s => s.reachable)
  // Worth saying once in the header rather than three times per row: on a
  // default install *every* CPU and MEM gauge is empty for the same reason.
  const noMetrics = servers.length > 0 && servers.every(s => s.metrics.source === 'off')

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
          {noMetrics && (
            <span className="fleet-nometrics" title={servers[0]?.metrics.note}>
              · no metrics source
            </span>
          )}
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
            {METERS.map(m => (
              <Meter
                key={m.key}
                label={m.label}
                value={server.metrics[m.key]}
                reason={m.key === 'dsk' ? DISK_NOTE : server.metrics.note}
              />
            ))}
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
