import type { CSSProperties, ReactNode } from 'react'
import { IconChevron } from './icons'

interface Props {
  title: string
  label: string
  count?: number
  /** "View all" link on the right of the header */
  more?: { label: string; onClick: (label: string) => void }
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
          <button className="more" onClick={() => more.onClick(more.label)}>
            {more.label}<IconChevron />
          </button>
        )}
        {meta && <div className="meta">{meta}</div>}
      </div>
      {children}
    </section>
  )
}
