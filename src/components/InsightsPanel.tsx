import type { CSSProperties } from 'react'
import type { Insight } from '../data'
import { IconChevron } from './icons'
import { Panel } from './Panel'
import './InsightsPanel.css'

const SEVERITY: Record<Insight['severity'], string> = {
  warn: 'var(--warn)',
  err: 'var(--err)',
  neutral: 'var(--accent)',
  ok: 'var(--t3)',
}

interface Props {
  insights: Insight[]
  index?: number
  onAction: (label: string) => void
}

/**
 * Every insight the BFF raises about a real resource carries a deep link into
 * Coolify's own UI (`href`), because a button that only acknowledges a problem
 * is not an action. The all-clear row has nowhere to go and keeps the callback.
 */
export function InsightsPanel({ insights, index, onAction }: Props) {
  return (
    <Panel title="Insights" label="Insights" count={insights.length} index={index}>
      {insights.map(ins => (
        <div className="ins" key={ins.id}>
          <span className="dot sev" style={{ '--c': SEVERITY[ins.severity] } as CSSProperties} />
          <div className="body">
            <div className="it">{ins.title}</div>
            <div className="idesc">{ins.description}</div>
            {ins.href ? (
              <a
                className="act"
                href={ins.href}
                target="_blank"
                rel="noreferrer noopener"
                title={`${ins.action} in Coolify`}
              >
                {ins.action}<IconChevron />
              </a>
            ) : (
              <button className="act" onClick={() => onAction(ins.action)}>
                {ins.action}<IconChevron />
              </button>
            )}
          </div>
        </div>
      ))}
    </Panel>
  )
}
