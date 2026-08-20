import { useEffect, useState } from 'react'
import { Panel } from '../components/Panel'
import { IconBranch, IconStatusErr, IconStatusOk } from '../components/icons'
import { DashboardError, source, type Deployment, type DeploymentHistoryResponse } from '../data'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useShell } from '../layout/context'
import './pages.css'

const PAGE = 50

const STATE_LABEL: Record<Deployment['state'], string> = {
  running: 'Running',
  success: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/**
 * The whole deployment history, which the overview panel only shows five rows
 * of. Coolify's `/deployments` returns *only* what is queued or running, so this
 * is assembled by the BFF from each application's own history and re-sorted —
 * which is also why it is bounded by `DEPLOYMENT_HISTORY_TAKE` per application,
 * a limit the page states rather than hides.
 */
export function Deployments() {
  useDocumentTitle('Deployments')

  const { data, connected } = useShell()
  const [page, setPage] = useState<DeploymentHistoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [skip, setSkip] = useState(0)

  useEffect(() => {
    let live = true
    setError(null)
    void source
      .getDeployments({ env: data.environment, skip, take: PAGE })
      .then(answer => { if (live) setPage(answer) })
      .catch(cause => {
        if (live) setError(cause instanceof DashboardError ? cause.message : 'Could not load the history.')
      })
    return () => { live = false }
  }, [skip, data.environment])

  const rows = page?.deployments ?? []

  return (
    <>
      <header className="page-top">
        <h1>Deployments</h1>
        <p>
          {page ? `${page.total} known in ${page.environment}` : 'Loading…'}
          {connected ? ' · live' : ' · reconnecting'}
        </p>
      </header>

      {error && <p className="page-error" role="alert">{error}</p>}

      <Panel title="History" label="Deployment history" count={rows.length}>
        {rows.length === 0 && !error ? (
          <p className="page-empty">{page ? 'No deployment recorded for this environment.' : 'Loading…'}</p>
        ) : (
          rows.map(deployment => {
            const Status = deployment.state === 'failed' ? IconStatusErr : IconStatusOk
            return (
              <div className="dep" key={deployment.id}>
                <Status className={`status-ico ${deployment.state === 'failed' ? 'err' : 'ok'}`} />
                <div className="info">
                  <div className="l1">
                    <span className="app">{deployment.app}</span>
                    <span className="msg">{deployment.message}</span>
                  </div>
                  <div className="l2">
                    <span className="branch"><IconBranch />{deployment.branch}</span>
                    <span className="sha">{deployment.sha}</span>
                    <span className="sha">{STATE_LABEL[deployment.state]}</span>
                  </div>
                </div>
                <div className="right">
                  <span className="dur num">{deployment.duration ?? '—'}</span>
                  <span className="when num">{deployment.when ?? ''}</span>
                </div>
              </div>
            )
          })
        )}
      </Panel>

      {page && page.total > PAGE && (
        <nav className="pager" aria-label="Pagination">
          <button disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE))}>Newer</button>
          <span className="num">
            {skip + 1}–{Math.min(skip + PAGE, page.total)} of {page.total}
          </span>
          <button disabled={skip + PAGE >= page.total} onClick={() => setSkip(skip + PAGE)}>Older</button>
        </nav>
      )}

      {page?.notes.map(note => (
        <p className="page-note" key={`${note.scope}:${note.reason}`}>{note.reason}</p>
      ))}
    </>
  )
}
