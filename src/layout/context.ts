import { useOutletContext } from 'react-router'
import type { Dashboard } from '../data'
import type { Actions } from '../hooks/useActions'
import type { DeploymentLogs } from '../hooks/useLiveDashboard'

/**
 * What every page gets from the shell.
 *
 * The payload, the SSE channel and the action plumbing are mounted **once**, in
 * the layout route — so navigating between pages costs no request and does not
 * tear down the live stream. A page reads what it needs from here; none of them
 * fetches anything of its own except the two that genuinely cannot
 * (`ApplicationDetail`, `Setup`).
 */
export interface ShellContext {
  data: Dashboard
  reload: () => void
  /** true while the push channel is up — panels stop pretending when it is not */
  connected: boolean
  logs: DeploymentLogs
  actions: Actions
}

export const useShell = () => useOutletContext<ShellContext>()
