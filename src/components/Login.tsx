import { useState, type FormEvent } from 'react'
import { DashboardError } from '../data'
import { LogoMark } from './icons'
import './Login.css'

interface Props {
  /** Rejects with a `DashboardError`; its message and hint are shown as-is. */
  onSubmit: (password: string) => Promise<void>
}

/**
 * The sign-in screen, shown instead of the dashboard while the session is
 * `locked`. It is deliberately the only thing on the page: everything behind it
 * — the fleet, the deployment history, the deploy button — is exactly what the
 * password is there to protect.
 */
export function Login({ onSubmit }: Props) {
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<DashboardError | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending || !password) return
    setPending(true)
    setError(null)
    try {
      await onSubmit(password)
      // No success branch: signing in unmounts this component.
    } catch (cause) {
      setError(
        cause instanceof DashboardError
          ? cause
          : new DashboardError('internal', 'Could not reach the dashboard API.'),
      )
      setPassword('')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo" aria-hidden="true"><LogoMark /></div>
        <h1>Coolify dashboard</h1>
        <p className="sub">This dashboard is password-protected.</p>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
            disabled={pending}
            aria-invalid={error !== null}
            {...(error ? { 'aria-describedby': 'login-error' } : {})}
          />
        </label>

        {error && (
          <p className="login-error" id="login-error" role="alert">
            {error.message}
            {error.hint && <span className="hint"> {error.hint}</span>}
          </p>
        )}

        <button type="submit" disabled={pending || !password}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
