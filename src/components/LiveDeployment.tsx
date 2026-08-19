import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Deployment } from '../data'
import { HoldToCancel } from './HoldToCancel'
import { IconBranch } from './icons'
import { useInterval } from '../hooks/useInterval'

const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

/** Blur-out / blur-in of one ticker line. */
const SWAP_MS = 160
/** Dwell on a line when there is nothing newer to show. */
const HOLD_MS = 2400
/** Dwell when lines are still queued: fast enough to catch up, slow enough to read. */
const DRAIN_MS = 700
/**
 * How far behind the newest line the ticker will ever be. Joining a build that
 * is already 500 lines in must not mean six minutes of scrollback before the
 * ticker shows anything current — a tail jumps, it does not replay.
 */
const MAX_BACKLOG = 8

interface Props {
  deployment: Deployment
  /** the deployment's log so far — pushed lines when the live channel is up */
  lines: string[]
  /** true when new lines keep arriving: the ticker then drains instead of looping */
  streaming: boolean
  /** rejecting puts the row back in its running state */
  onCancel: (deployment: Deployment) => void | Promise<void>
}

export function LiveDeployment({ deployment, lines, streaming, onCancel }: Props) {
  // Anchor the chrono to a start instant rather than counting ticks: a
  // backgrounded tab throttles timers, and a counted second is a lost second.
  const startedAt = useRef(Date.now() - (deployment.elapsedSeconds ?? 0) * 1000)
  const [seconds, setSeconds] = useState(deployment.elapsedSeconds ?? 0)
  const [index, setIndex] = useState(0)
  const [swapping, setSwapping] = useState(false)
  const [cancelled, setCancelled] = useState(false)

  useInterval(
    () => setSeconds(Math.max(0, Math.round((Date.now() - startedAt.current) / 1000))),
    cancelled ? null : 1000,
  )

  // One line at a time, blurred out and back in. A stream drains toward its
  // newest line and then holds it; a fixed list (mock, or no live channel)
  // loops, which is what the mockup does. The whole swap lives in one effect,
  // so cancelling mid-swap can never leave the line blurred out.
  useEffect(() => {
    if (cancelled || lines.length === 0) {
      setSwapping(false)
      return
    }
    const behind = index < lines.length - 1
    // Caught up with the stream: hold the last line instead of looping over it.
    if (streaming && !behind) return

    let blur: number | undefined
    const wait = setTimeout(
      () => {
        setSwapping(true)
        blur = window.setTimeout(() => {
          setIndex(i =>
            streaming
              ? Math.max(Math.min(i + 1, lines.length - 1), lines.length - MAX_BACKLOG)
              : (i + 1) % lines.length,
          )
          setSwapping(false)
        }, SWAP_MS)
      },
      streaming && behind ? DRAIN_MS : HOLD_MS,
    )
    return () => { clearTimeout(wait); clearTimeout(blur) }
  }, [cancelled, streaming, index, lines.length])

  const cancel = async () => {
    setCancelled(true)
    try {
      await onCancel(deployment)
    } catch {
      setCancelled(false)
    }
  }

  const line = lines[Math.min(index, lines.length - 1)]

  return (
    <div className="dep dep--live">
      <span
        className={cancelled ? 'dot' : 'dot dot--pulse'}
        style={{ '--c': cancelled ? 'var(--t3)' : 'var(--accent)' } as CSSProperties}
      />
      <div className="info">
        <div className="l1">
          <span className="app">{deployment.app}</span>
          {!cancelled && <span className="pill pill--live">Running</span>}
          <span className="msg">{deployment.message}</span>
        </div>
        <div className="l2">
          <span className="branch"><IconBranch />{deployment.branch}</span>
          <span className="sha">{deployment.sha}</span>
        </div>
        <div className={`ticker num${swapping ? ' swap' : ''}${cancelled ? ' done' : ''}`}>
          {cancelled
            ? '▸ deployment cancelled by user'
            : (line ?? '▸ waiting for build output…')}
        </div>
      </div>
      <div className="right">
        <span className="dur num">{mmss(seconds)}</span>
        <HoldToCancel label="Hold to cancel" gone={cancelled} onHold={() => { void cancel() }} />
      </div>
      {!cancelled && <div className="dep-progress" aria-hidden="true"><i /></div>}
    </div>
  )
}
