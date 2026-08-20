import './LoadError.css'

interface Props {
  message: string
  hint?: string
  onRetry: () => void
  /** Opens the setup check — the reason this screen rarely has to be the last word. */
  onRunSetup: () => void
}

/** Shown instead of a blank screen when `/app/overview` cannot be read. */
export function LoadError({ message, hint, onRetry, onRunSetup }: Props) {
  return (
    <div className="loaderr" role="alert">
      <div className="loaderr-card">
        <h1>The dashboard has no data to show</h1>
        <p className="msg">{message}</p>
        {hint && <p className="hint">{hint}</p>}
        <div className="actions">
          <button onClick={onRetry}>Try again</button>
          {/* Four different problems produce this screen; the check says which. */}
          <button className="ghost" onClick={onRunSetup}>Run the setup check</button>
        </div>
      </div>
    </div>
  )
}
