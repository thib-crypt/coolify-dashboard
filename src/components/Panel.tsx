import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router'
import { IconChevron } from './icons'

interface Props {
  title: string
  label: string
  count?: number
  /** "View all" on the right of the header, and the route it opens */
  more?: { label: string; to: string }
  meta?: ReactNode
  /** entrance-animation stagger index */
  index?: number
  children: ReactNode
}

export function Panel({ title, label, count, more, meta, index = 0, children }: Props) {
  return (
    <section className="panel" data-animate style={{ '--i': index } as CSSProperties} aria-label={label}>
      <div className="panel-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="count num">{count}</span>}
        {more && (
          <Link className="more" to={more.to}>
            {more.label}<IconChevron />
          </Link>
        )}
        {meta && <div className="meta">{meta}</div>}
      </div>
      {children}
    </section>
  )
}
