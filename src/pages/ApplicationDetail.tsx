import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Panel } from '../components/Panel'
import { IconBranch, IconStatusErr, IconStatusOk } from '../components/icons'
import {
  DashboardError,
  source,
  type ApplicationDetailResponse,
  type ApplicationLogsResponse,
  type Deployment,
} from '../data'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useShell } from '../layout/context'
import './pages.css'

const LOG_LINES = 200
const HISTORY = 20

/**
 * One application, with the four things the overview has no room for: what it
 * is, what it is running, what it has deployed, and what it can be rolled back
 * to.
 *
 * Two of those come with honest holes. Environment variable **values** are
 * absent — not redacted — without `read:sensitive`, and runtime logs answer
 * `400 "Application is not running."` for a stopped container. Both are states
 * rather than failures, and the page says which one it is looking at instead of
 * rendering an empty box.
 */
export function ApplicationDetail() {
  const { uuid = '' } = useParams()
  const { data, actions, reload } = useShell()

  const [app, setApp] = useState<ApplicationDetailResponse | null>(null)
  const [history, setHistory] = useState<Deployment[]>([])
  const [logs, setLogs] = useState<ApplicationLogsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useDocumentTitle(app?.name ?? 'Application')

  const load = useCallback(async () => {
    setError(null)
    try {
      const [detail, page] = await Promise.all([
        source.getApplication(uuid),
        // Scoped like every other read on screen: this application's history
        // is only asked for within the environment the topbar is showing.
        source.getDeployments({ env: data.environment, application: uuid, take: HISTORY }),
      ])
      setApp(detail)
      setHistory(page.deployments)
    } catch (cause) {
      setError(cause instanceof DashboardError ? cause.message : 'Could not load this application.')
    }
    // Logs are fetched apart: they are the one read that legitimately fails,
    // and a stopped container must not blank the rest of the page.
    try {
      setLogs(await source.getApplicationLogs(uuid, LOG_LINES))
    } catch (cause) {
      setLogs({ lines: [], note: cause instanceof DashboardError ? cause.message : 'Could not read the logs.' })
    }
  }, [uuid, data.environment])

  useEffect(() => { void load() }, [load])

  // The overview's copy carries the domain and the measured uptime, and it is
  // refreshed by the live channel — so it wins for those two while it exists.
  const listed = data.applications.find(entry => entry.id === uuid)

  if (error && !app) {
    return (
      <header className="page-top">
        <h1>Application</h1>
        <p className="page-error" role="alert">{error}</p>
        <p><Link to="/applications">Back to all applications</Link></p>
      </header>
    )
  }

  if (!app) return <header className="page-top"><h1>Loading…</h1></header>

  const running = app.status.state === 'running'

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await run()
      reload()
      await load()
    } catch {
      // `actions` has already toasted the reason.
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="page-top">
        <p className="crumb"><Link to="/applications">Applications</Link> / {app.name}</p>
        <h1>{app.name}</h1>
        <p>
          <span className={`pill ${running ? 'ok' : 'warn'}`}>
            {app.status.state}{app.status.health ? ` · ${app.status.health}` : ''}
          </span>
          {(listed?.domain || app.domain) && <span className="mono"> {listed?.domain || app.domain}</span>}
          {app.environment && <span> · {app.environment}</span>}
          {app.serverName && <span> · {app.serverName}</span>}
        </p>

        <div className="row-actions page-actions">
          <button disabled={busy} onClick={() => void act(() => actions.deployAndWatch(uuid, app.name))}>
            Deploy
          </button>
          <button disabled={busy} onClick={() => void act(() => actions.restart(uuid, app.name))}>Restart</button>
          <button className="danger" disabled={busy} onClick={() => void act(() => actions.stop(uuid, app.name))}>
            Stop
          </button>
          {app.link && (
            <a className="ghost" href={app.link} target="_blank" rel="noreferrer noopener">Open in Coolify ↗</a>
          )}
        </div>
      </header>

      <div className="grid-2">
        <Panel title="Details" label="Application details">
          <dl className="facts">
            <div><dt>Repository</dt><dd className="mono">{app.repository ?? '—'}</dd></div>
            <div><dt>Branch</dt><dd className="mono">{app.branch ?? '—'}</dd></div>
            <div><dt>Build pack</dt><dd>{app.buildPack ?? '—'}</dd></div>
            <div>
              <dt>Uptime (24 h)</dt>
              <dd className="mono" title="Measured by this dashboard, not by Coolify">
                {listed?.uptime ?? app.uptime ?? '—'}
              </dd>
            </div>
            <div>
              <dt>Auto-deploy</dt>
              <dd>
                {app.autoDeploy === null ? '—' : (
                  <button
                    className="tgl"
                    role="switch"
                    aria-checked={app.autoDeploy}
                    aria-label={`Auto deploy ${app.name}`}
                    disabled={busy}
                    onClick={() => void act(() => actions.setAutoDeploy(uuid, app.name, !app.autoDeploy))}
                  />
                )}
              </dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Rollback" label="Rollback targets" count={app.rollback.targets.length}>
          {app.rollback.targets.length === 0 ? (
            <p className="page-empty">
              Nothing to roll back to. Coolify reads this with <code>docker images</code> over SSH, so an
              unreachable server also answers an empty list.
            </p>
          ) : (
            app.rollback.targets.map(target => (
              <div className="joblist-row" key={target.tag}>
                <div className="id">
                  <div className="an mono">{target.tag}</div>
                  <div className="ad">{target.createdAt ?? 'unknown date'}</div>
                </div>
                <div className="row-actions">
                  {target.current ? (
                    <span className="pill ok">Running</span>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const result = await source.rollback(uuid, target.tag)
                          actions.say(result.message)
                        })
                      }
                    >
                      Roll back
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </Panel>
      </div>

      <Panel title="Deployments" label="Deployment history" count={history.length}>
        {history.length === 0 ? (
          <p className="page-empty">No deployment recorded for this application.</p>
        ) : (
          history.map(deployment => {
            const Status = deployment.state === 'failed' ? IconStatusErr : IconStatusOk
            return (
              <div className="dep" key={deployment.id}>
                <Status className={`status-ico ${deployment.state === 'failed' ? 'err' : 'ok'}`} />
                <div className="info">
                  <div className="l1"><span className="msg">{deployment.message}</span></div>
                  <div className="l2">
                    <span className="branch"><IconBranch />{deployment.branch}</span>
                    <span className="sha">{deployment.sha}</span>
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

      <div className="grid-2">
        <Panel
          title="Environment"
          label="Environment variables"
          count={app.envs.length}
          meta={<button className="linkish" onClick={() => void load()}>Refresh</button>}
        >
          {app.envs.length === 0 ? (
            <p className="page-empty">No environment variable, or the token cannot list them.</p>
          ) : (
            app.envs.map(env => (
              <div className="envrow" key={env.key}>
                <span className="k mono">{env.key}</span>
                <span className={`v mono ${env.value === null ? 'hidden' : ''}`}>
                  {env.value === null
                    ? (env.writeOnly ? 'shown once — Coolify never returns it' : 'hidden — needs read:sensitive')
                    : env.value}
                </span>
                <span className="tags">
                  {env.buildTime && <span className="pill">build</span>}
                  {env.preview && <span className="pill">preview</span>}
                </span>
              </div>
            ))
          )}
        </Panel>

        <Panel
          title="Runtime logs"
          label="Runtime logs"
          meta={<button className="linkish" onClick={() => void load()}>Refresh</button>}
        >
          {logs === null ? (
            <p className="page-empty">Loading…</p>
          ) : logs.lines.length === 0 ? (
            <p className="page-empty">{logs.note ?? 'No output.'}</p>
          ) : (
            <pre className="logbox">{logs.lines.join('\n')}</pre>
          )}
        </Panel>
      </div>

      {app.notes.map(note => (
        <p className="page-note" key={`${note.scope}:${note.reason}`}>{note.reason}</p>
      ))}
    </>
  )
}
