import './LoadError.css'

interface Props {
  message: string
  hint?: string
  onRetry: () => void
}

/** Shown instead of a blank screen when `/app/overview` cannot be read. */
export function LoadError({ message, hint, onRetry }: Props) {
  return (
    <div className="loaderr" role="alert">
      <div className="loaderr-card">
        <h1>The dashboard has no data to show</h1>
        <p className="msg">{message}</p>
        {hint && <p className="hint">{hint}</p>}
        <button onClick={onRetry}>Try again</button>
      </div>
    </div>
  )
}
