import type { CSSProperties } from 'react'
import type { Kpi } from '../data'
import { IconCaretUp, KPI_ICONS } from './icons'
import './Kpi.css'

const PILL_CLASS: Record<string, string> = {
  ok: 'pill pill--ok',
  warn: 'pill pill--warn',
  err: 'pill pill--err',
  neutral: 'pill',
}

function Sparkline({ points }: { points: Array<[number, number]> }) {
  const last = points[points.length - 1]
  return (
    <svg className="spark" width="84" height="30" viewBox="0 0 84 30">
      <polyline pathLength="1" points={points.map(([x, y]) => `${x},${y}`).join(' ')} />
      <circle cx={last[0]} cy={last[1]} r="2" />
    </svg>
  )
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  const Icon = KPI_ICONS[kpi.icon]
  return (
    <div className="kpi">
      <div className="k-top">
        <span className="k-ico" aria-hidden="true"><Icon /></span>
        <span className="k-label">{kpi.label}</span>
        <span className={PILL_CLASS[kpi.badge.trend]}>
          {kpi.badge.caret && <IconCaretUp />}{kpi.badge.text}
        </span>
      </div>
      <div className="k-row">
        <div>
          <div className="k-value num">
            {kpi.value}{kpi.unit && <span className="unit">{kpi.unit}</span>}
          </div>
          <div className="k-sub">{kpi.sub}</div>
        </div>
        <Sparkline points={kpi.spark} />
      </div>
    </div>
  )
}

export function KpiGrid({ kpis, index = 0 }: { kpis: Kpi[]; index?: number }) {
  return (
    <section className="kpis" data-animate style={{ '--i': index } as CSSProperties} aria-label="Key metrics">
      {kpis.map(kpi => <KpiCard key={kpi.id} kpi={kpi} />)}
    </section>
  )
}
