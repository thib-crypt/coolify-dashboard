import type { Timeline } from '../data'
import { Panel } from './Panel'
import './SchedulePanel.css'

export function SchedulePanel({ timeline, index }: { timeline: Timeline; index?: number }) {
  return (
    <Panel
      title="Scheduled"
      label="Scheduled tasks"
      count={timeline.jobs.length}
      index={index}
      meta="next 24 h"
    >
      <div className="timeline" role="list">
        <div className="tl-line" />
        <div className="tl-now" style={{ left: `${timeline.now.left}%` }}>
          <span>{timeline.now.label}</span>
        </div>
        {timeline.ticks.map(tick => (
          <div className="tl-tick" key={tick.label} style={{ left: `${tick.left}%` }}>
            <span>{tick.label}</span>
          </div>
        ))}
        {timeline.jobs.map(job => (
          <div className="job" role="listitem" key={job.id} style={{ left: `${job.left}%` }} tabIndex={0}>
            <i />
            <div className="job-tip">
              <b>{job.title}</b><span>{job.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}
