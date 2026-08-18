import { useEffect, useLayoutEffect, useRef } from 'react'
import type { EnvironmentName } from '../data'

interface Props {
  environments: EnvironmentName[]
  value: EnvironmentName
  onChange: (env: EnvironmentName) => void
}

/** iOS-style segmented control: the thumb slides, and snaps without animation on resize. */
export function EnvSwitch({ environments, value, onChange }: Props) {
  const thumb = useRef<HTMLSpanElement>(null)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const index = environments.indexOf(value)

  const move = (instant: boolean) => {
    const btn = buttons.current[index]
    const el = thumb.current
    if (!btn || !el) return
    if (instant) el.style.transition = 'none'
    el.style.width = `${btn.offsetWidth}px`
    el.style.transform = `translateX(${btn.offsetLeft}px)`
    if (instant) requestAnimationFrame(() => { el.style.transition = '' })
  }

  // first paint: place the thumb without animating it in
  useLayoutEffect(() => { move(true) }, [])
  // subsequent selection changes animate
  useEffect(() => { move(false) }, [index])

  useEffect(() => {
    const onResize = () => move(true)
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  })

  return (
    <div className="env" role="group" aria-label="Environment">
      <span className="env-thumb" ref={thumb} aria-hidden="true" />
      {environments.map((env, i) => (
        <button
          key={env}
          ref={el => { buttons.current[i] = el }}
          aria-pressed={env === value}
          onClick={() => onChange(env)}
        >
          {env}
        </button>
      ))}
    </div>
  )
}
