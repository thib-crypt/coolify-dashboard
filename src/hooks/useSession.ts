import { useCallback, useEffect, useState } from 'react'
import { DashboardError, SESSION_LOST, source } from '../data'

/**
 * The dashboard's front door, seen from the browser (phase 7 of docs/roadmap.md).
 *
 * `unknown` is the state before the first answer comes back, and it renders
 * nothing: flashing a sign-in form at someone who already has a session — every
 * reload, for the length of one request — is worse than a blank frame.
 *
 * A deployment with no `DASHBOARD_PASSWORD` answers `required: false`, and this
 * hook then stays out of the way for the rest of the session.
 */
export type SessionState = 'unknown' | 'locked' | 'open'

export interface Session {
  state: SessionState
  /** false when the BFF has no password: no sign-in screen, no sign-out button */
  required: boolean
  /** Rejects with a `DashboardError` the form can show — wrong password, throttled. */
  signIn: (password: string) => Promise<void>
  signOut: () => Promise<void>
}

export function useSession(): Session {
  const [state, setState] = useState<SessionState>('unknown')
  const [required, setRequired] = useState(false)

  useEffect(() => {
    let live = true

    void source
      .getSession()
      .then(session => {
        if (!live) return
        setRequired(session.required)
        setState(session.authenticated ? 'open' : 'locked')
      })
      .catch(error => {
        if (!live) return
        // The BFF is unreachable, or something else is broken. Locking the UI
        // here would say "wrong password" about a network failure; letting it
        // through puts the real error on screen, with its retry button.
        setState(error instanceof DashboardError && error.code === 'unauthenticated' ? 'locked' : 'open')
      })

    // Any 401, from any request, means the session is gone (`data/types.ts`).
    const onLost = () => setState('locked')
    addEventListener(SESSION_LOST, onLost)

    return () => {
      live = false
      removeEventListener(SESSION_LOST, onLost)
    }
  }, [])

  const signIn = useCallback(async (password: string) => {
    const session = await source.signIn(password)
    setRequired(session.required)
    setState(session.authenticated ? 'open' : 'locked')
  }, [])

  const signOut = useCallback(async () => {
    // Locked first: the cookie is already gone as far as this tab is concerned,
    // and the dashboard behind it must stop refetching before it starts 401ing.
    setState('locked')
    await source.signOut().catch(() => {})
  }, [])

  return { state, required, signIn, signOut }
}
