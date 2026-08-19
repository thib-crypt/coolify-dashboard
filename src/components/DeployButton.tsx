import { useRef, useState } from 'react'
import { IconCheckMark } from './icons'

type Face = 'idle' | 'busy' | 'done'

const DONE_MS = 1800

/** idle → busy → done → idle, with the button width morphing between each state.
    The busy face lasts exactly as long as the request: no faked duration. */
export function DeployButton({ onDeploy }: { onDeploy: () => Promise<unknown> }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [face, setFace] = useState<Face>('idle')
  const deploying = useRef(false)

  const click = async () => {
    const el = btn.current
    if (deploying.current || !el) return
    deploying.current = true

    el.style.width = `${el.offsetWidth}px`   // pin the current width so it can transition
    setFace('busy')
    el.style.width = '108px'

    try {
      await onDeploy()
      setFace('done')
      el.style.width = '104px'
      await new Promise(resolve => setTimeout(resolve, DONE_MS))
    } catch {
      // the toast raised by the caller carries the reason
    }

    setFace('idle')
    el.style.width = ''
    deploying.current = false
  }

  return (
    <button
      className={`deploy num${face === 'done' ? ' is-done' : ''}`}
      ref={btn}
      disabled={face === 'busy'}
      onClick={() => { void click() }}
    >
      <span className="face" data-face="idle" hidden={face !== 'idle'}>Deploy</span>
      <span className="face" data-face="busy" hidden={face !== 'busy'}>
        <span className="spin" aria-hidden="true" />Deploying
      </span>
      <span className="face" data-face="done" hidden={face !== 'done'}>
        <IconCheckMark />Deployed
      </span>
    </button>
  )
}
