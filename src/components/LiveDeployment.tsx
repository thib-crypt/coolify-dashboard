import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Deployment } from '../data'
import { HoldToCancel } from './HoldToCancel'
import { IconBranch } from './icons'
import { useInterval } from '../hooks/useInterval'

const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

interface Props {
  deployment: Deployment
  onCancel: (deployment: Deployment) => void
}

export function LiveDeployment({ deployment, onCancel }: Props) {
  const logs = deployment.logs ?? []
  const [seconds, setSeconds] = useState(deployment.elapsedSeconds ?? 0)
  const [logIndex, setLogIndex] = useState(0)
  const [swapping, setSwapping] = useState(false)
  const [cancelled, setCancelled] = useState(false)

  useInterval(() => setSeconds(s => s + 1), cancelled ? null : 1000)

  // log ticker: blur out, swap the line, blur back in — one self-contained
  // sequence, so cancelling mid-swap can never leave the line blurred out.
  useEffect(() => {
    if (cancelled || logs.length === 0) {
      setSwapping(false)
      return
    }
    let swap: number | undefined
    const rotate = setInterval(() => {
      setSwapping(true)
      swap = window.setTimeout(() => {
        setLogIndex(i => (i + 1) % logs.length)
        setSwapping(false)
      }, 160)
    }, 2400)
    return () => { clearInterval(rotate); clearTimeout(swap) }
  }, [cancelled, logs.length])

  const cancel = () => {
    setCancelled(true)
    onCancel(deployment)
  }

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
          {cancelled ? '▸ deployment cancelled by user' : logs[logIndex]}
        </div>
      </div>
      <div className="right">
        <span className="dur num">{mmss(seconds)}</span>
        <HoldToCancel label="Hold to cancel" gone={cancelled} onHold={cancel} />
      </div>
      {!cancelled && <div className="dep-progress" aria-hidden="true"><i /></div>}
    </div>
  )
}
