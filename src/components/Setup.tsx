import { useEffect, useState } from 'react'
import { DashboardError, source, type CheckStatus, type SetupReport } from '../data'
import './Setup.css'

/**
 * The first-run diagnostic, on screen (phase 7 of docs/roadmap.md).
 *
 * It exists because the four ways a Coolify token can be wrong — revoked, short
 * of an ability, owned by a team member rather than an admin, or coming from an
 * IP that is not allowlisted — all look the same from here: a panel that will
 * not load. Every check below names which one it is and links to the page that
 * fixes it.
 *
 * Nothing it runs changes anything, so it is safe to open at any time.
 */

const LABELS: Record<CheckStatus, string> = {
  ok: 'OK',
  warn: 'Heads up',
  fail: 'Blocking',
  unknown: 'Unknown',
}

interface Props {
  /** Back to the dashboard — which may still be broken, hence the retry too. */
  onClose: () => void
  onRetry: () => void
}

export function Setup({ onClose, onRetry }: Props) {
  const [report, setReport] = useState<SetupReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(true)

  async function run() {
    setRunning(true)
    setError(null)
    try {
      setReport(await source.getSetup())
    } catch (cause) {
      setError(cause instanceof DashboardError ? cause.message : 'Could not reach the dashboard API.')
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => { void run() }, [])

  const failures = report?.checks.filter(check => check.status === 'fail').length ?? 0

  return (
    <div className="setup">
      <div className="setup-card">
        <header>
          <h1>Setup check</h1>
          <p className="sub">
            {report
              ? report.ok
                ? 'Everything the dashboard needs is in place.'
                : `${failures} thing${failures > 1 ? 's' : ''} to fix before the dashboard can work.`
              : running
                ? 'Asking your instance…'
                : 'The check itself could not run.'}
          </p>
        </header>

        {report && (report.version || report.team) && (
          <p className="setup-meta">
            {report.version && <span>Coolify {report.version}</span>}
            {report.team && <span>Team {report.team}</span>}
            {report.coolifyUrl && <span className="url">{report.coolifyUrl}</span>}
          </p>
        )}

        {error && <p className="setup-failed" role="alert">{error}</p>}

        <ul className="setup-list">
          {report?.checks.map(check => (
            <li key={check.id} className={`setup-check is-${check.status}`}>
              <span className="badge" aria-label={LABELS[check.status]} title={LABELS[check.status]} />
              <div className="body">
                <p className="title">{check.title}</p>
                <p className="detail">{check.detail}</p>
                {check.hint && <p className="hint">{check.hint}</p>}
                {check.link && (
                  <a className="fix" href={check.link} target="_blank" rel="noreferrer noopener">
                    Fix this in Coolify ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>

        <footer>
          <button className="ghost" onClick={() => void run()} disabled={running}>
            {running ? 'Checking…' : 'Run again'}
          </button>
          <button
            onClick={() => {
              onRetry()
              onClose()
            }}
          >
            Back to the dashboard
          </button>
        </footer>
      </div>
    </div>
  )
}
