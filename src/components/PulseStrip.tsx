import { useEffect, useRef } from 'react'
import { useInterval } from '../hooks/useInterval'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { PULSE_HEIGHT, STEP, TICK, pulsePaths, useTraffic } from '../hooks/useTraffic'
import './PulseStrip.css'

/** Edge-traffic conveyor: the group slides left by exactly one step per tick,
    then snaps back as the new sample is appended — so the line never jumps. */
export function PulseStrip() {
  const { series, width, latest, tick, available } = useTraffic()
  const group = useRef<SVGGElement>(null)
  const reduced = useReducedMotion()
  const anim = useRef<Animation | null>(null)

  useInterval(() => {
    tick()
    if (reduced) return
    const g = group.current
    if (!g) return
    anim.current?.cancel()
    anim.current = g.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(-${STEP}px)` }],
      { duration: TICK, easing: 'linear' },
    )
  }, available ? TICK : null)

  useEffect(() => () => anim.current?.cancel(), [])

  const { line, area } = pulsePaths(series)

  return (
    <div className="pulse" aria-hidden="true">
      {available && (
        <svg viewBox={`0 0 ${width} ${PULSE_HEIGHT}`} preserveAspectRatio="none">
          <g ref={group}>
            <path d={area} fill="rgba(37,99,235,.055)" />
            <path d={line} fill="none" stroke="rgba(37,99,235,.34)" strokeWidth="1.5" strokeLinejoin="round" />
          </g>
        </svg>
      )}
      <div className="fade" />
      <div className="label">
        <span className="dot" style={{ '--c': available ? 'var(--ok)' : 'var(--t3)' } as React.CSSProperties} />
        {available ? (
          <>edge traffic&nbsp;·&nbsp;<b className="num">{(latest / 1000).toFixed(2)}k req/s</b></>
        ) : (
          <>edge traffic&nbsp;·&nbsp;<b className="num">no source</b></>
        )}
      </div>
    </div>
  )
}
