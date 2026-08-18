import type { CSSProperties } from 'react'
import { IconCalendar, IconFilters } from './icons'

export function PageHead({ index = 0 }: { index?: number }) {
  return (
    <div className="page-head" data-animate style={{ '--i': index } as CSSProperties}>
      <div>
        <h1>Overview</h1>
        <p>Everything running across your infrastructure</p>
      </div>
      <div className="tools">
        <button className="ghost-btn"><IconFilters />Filters</button>
        <button className="ghost-btn"><IconCalendar />Last 7 days</button>
      </div>
    </div>
  )
}
