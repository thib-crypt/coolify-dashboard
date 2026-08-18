import { useEffect, useRef } from 'react'

/** Press and keep pressing: the red fill wipes across in 1.4 s (linear).
    Release early and it snaps back in 200 ms — only a completed wipe fires onHold. */
export function HoldToCancel({ label, gone, onHold }: { label: string; gone: boolean; onHold: () => void }) {
  const pressing = useRef(false)
  const fill = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const up = () => { pressing.current = false }
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
    return () => {
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
    }
  }, [])

  useEffect(() => {
    const el = fill.current
    if (!el) return
    const done = (e: TransitionEvent) => {
      if (!pressing.current || e.propertyName !== 'clip-path') return
      pressing.current = false
      onHold()
    }
    el.addEventListener('transitionend', done)
    return () => el.removeEventListener('transitionend', done)
  }, [onHold])

  return (
    <button
      className={`hold${gone ? ' gone' : ''}`}
      onPointerDown={() => { pressing.current = true }}
    >
      <span className="fill" ref={fill} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}
