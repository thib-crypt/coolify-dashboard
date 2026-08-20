import { Panel } from '../components/Panel'
import { SchedulePanel } from '../components/SchedulePanel'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useShell } from '../layout/context'
import './pages.css'

/**
 * The next 24 hours, and the list behind the strip. Coolify keeps scheduled
 * tasks and backup schedules on the resources that own them and never in one
 * place; the BFF gathers both and parses their cron expressions, which is what
 * makes this page possible at all.
 */
export function Schedule() {
  useDocumentTitle('Schedule')

  const { data, actions } = useShell()
  const jobs = data.timeline.jobs

  return (
    <>
      <header className="page-top">
        <h1>Schedule</h1>
        <p>Scheduled tasks and database backups, placed on the next 24 hours from their cron expressions.</p>
      </header>

      <SchedulePanel timeline={data.timeline} />

      <Panel title="Jobs" label="Scheduled jobs" count={jobs.length}>
        {jobs.length === 0 ? (
          <p className="page-empty">
            Nothing scheduled in this environment — no scheduled task, and no database backup.
          </p>
        ) : (
          jobs.map(job => {
            // Only tasks can be run on demand; a backup schedule has no such route.
            const task = data.paletteActions.find(
              action => action.command.kind === 'run-task' && action.title === job.title,
            )
            const command = task?.command.kind === 'run-task' ? task.command : null
            return (
              <div className="joblist-row" key={job.id}>
                <div className="id">
                  <div className="an">{job.title}</div>
                  <div className="ad">{job.detail}</div>
                </div>
                {command && (
                  <div className="row-actions">
                    <button
                      onClick={() => {
                        void actions.runTask(command.owner, command.ownerId, command.task, job.title)
                      }}
                    >
                      Run now
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </Panel>
    </>
  )
}
