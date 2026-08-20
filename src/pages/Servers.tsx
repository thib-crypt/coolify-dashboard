import { Panel } from '../components/Panel'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useShell } from '../layout/context'
import './pages.css'

/**
 * The fleet, with the reason behind every missing number spelled out rather
 * than hidden in a tooltip. Coolify publishes no metrics endpoint at all, so on
 * a default install most of this page is em dashes — and saying *which* silence
 * each one is is the entire point of showing it.
 */
export function Servers() {
  useDocumentTitle('Servers')

  const { data } = useShell()

  return (
    <>
      <header className="page-top">
        <h1>Servers</h1>
        <p>
          Reachability and latency are measured from this dashboard. CPU and RAM come from
          each server's Sentinel agent over SSH, when a key is configured.
        </p>
      </header>

      <div className="page-grid">
        {data.servers.map(server => (
          <Panel key={server.id} title={server.name} label={server.name}>
            <div className="server-card">
              <p className="server-meta">
                <span className={`pill ${server.reachable ? 'ok' : 'err'}`}>
                  {server.reachable ? 'Reachable' : 'Unreachable'}
                </span>
                <span>{server.region}</span>
                <span className="num">{server.pingMs === null ? '— ms' : `${server.pingMs} ms`}</span>
              </p>

              <dl className="gauges">
                {([
                  ['CPU', server.metrics.cpu],
                  ['Memory', server.metrics.mem],
                  ['Disk', server.metrics.dsk],
                ] as const).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd className="num">{value === null ? '—' : `${Math.round(value)} %`}</dd>
                    {value !== null && (
                      <div className="bar"><span style={{ width: `${Math.min(100, value)}%` }} /></div>
                    )}
                  </div>
                ))}
              </dl>

              <p className="server-note">{server.metrics.note}</p>
            </div>
          </Panel>
        ))}
      </div>

      {data.servers.length === 0 && <p className="page-empty">No server visible to this token.</p>}
    </>
  )
}
