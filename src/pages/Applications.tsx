import { useState } from 'react'
import { Link } from 'react-router'
import { Panel } from '../components/Panel'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useShell } from '../layout/context'
import './pages.css'

/**
 * Every application in the selected environment, which the overview panel only
 * ever showed the top of. The payload already carries the whole list — it is
 * the panel that was truncating — so this page costs no extra request.
 */
export function Applications() {
  useDocumentTitle('Applications')

  const { data, actions } = useShell()
  const [query, setQuery] = useState('')

  const needle = query.trim().toLowerCase()
  const applications = needle
    ? data.applications.filter(
        app => app.name.toLowerCase().includes(needle) || app.domain.toLowerCase().includes(needle),
      )
    : data.applications

  return (
    <>
      <header className="page-top">
        <h1>Applications</h1>
        <p>{data.applicationCount} in {data.environment}, with uptime measured here over 24 h.</p>
        <input
          className="page-filter"
          type="search"
          placeholder="Filter by name or domain"
          value={query}
          onChange={event => setQuery(event.target.value)}
          aria-label="Filter applications"
        />
      </header>

      <Panel title="All applications" label="All applications" count={applications.length}>
        {applications.length === 0 ? (
          <p className="page-empty">
            {needle ? `Nothing matches “${query}”.` : 'No application in this environment.'}
          </p>
        ) : (
          applications.map(app => (
            <div className="approw" key={app.id}>
              <span className="appic" style={{ background: app.gradient }}>{app.initial}</span>
              <Link className="id" to={`/applications/${encodeURIComponent(app.id)}`}>
                <div className="an">{app.name}</div>
                <div className="ad">{app.domain}</div>
              </Link>
              <span
                className="up"
                title={app.uptime ? 'Measured by this dashboard over the last 24 h' : 'Not probed — no public domain, or probing is off'}
              >
                {app.uptime ?? '—'}
              </span>
              <div className="row-actions">
                <button onClick={() => { void actions.deploy(app.id, app.name) }}>Deploy</button>
                <button onClick={() => { void actions.restart(app.id, app.name) }}>Restart</button>
                <button className="danger" onClick={() => { void actions.stop(app.id, app.name) }}>Stop</button>
              </div>
            </div>
          ))
        )}
      </Panel>
    </>
  )
}
