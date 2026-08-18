import { useRef, useState } from 'react'
import { IconCheckMark } from './icons'

type Face = 'idle' | 'busy' | 'done'

/** idle → busy → done → idle, with the button width morphing between each state. */
export function DeployButton({ onDeploy }: { onDeploy: () => void }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [face, setFace] = useState<Face>('idle')
  const deploying = useRef(false)

  const click = () => {
    const el = btn.current
    if (deploying.current || !el) return
    deploying.current = true

    el.style.width = `${el.offsetWidth}px`   // pin the current width so it can transition
    setFace('busy')
    el.style.width = '108px'
    onDeploy()

    setTimeout(() => {
      setFace('done')
      el.style.width = '104px'
      setTimeout(() => {
        setFace('idle')
        el.style.width = ''
        deploying.current = false
      }, 2200)
    }, 2800)
  }

  return (
    <button
      className={`deploy num${face === 'done' ? ' is-done' : ''}`}
      ref={btn}
      onClick={click}
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
