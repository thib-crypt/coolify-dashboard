import { useCallback, useEffect, useState } from 'react'
import { source } from '../data'

export const STEP = 20
export const PULSE_HEIGHT = 52
export const TICK = 1200

/** The conveyor sparkline behind the topbar: one new sample every 1200 ms,
    the whole series shifted left by exactly one step.
    Coolify core has no traffic metrics, so a source may report `null` — the
    strip then says it has no data instead of drawing an invented line. */
export function useTraffic() {
  const [width, setWidth] = useState(() => innerWidth)
  const count = Math.ceil(width / STEP) + 3
  const [available] = useState(() => source.initialTraffic() !== null)
  const [series, setSeries] = useState<number[]>(() =>
    Array.from({ length: Math.ceil(innerWidth / STEP) + 3 }, () => source.initialTraffic() ?? 0),
  )

  useEffect(() => {
    const onResize = () => setWidth(innerWidth)
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [])

  // keep the series length in sync with the viewport, padding from the left
  useEffect(() => {
    setSeries(prev => {
      if (prev.length === count) return prev
      const next = [...prev]
      while (next.length < count) next.unshift(next[0] ?? 0)
      while (next.length > count) next.shift()
      return next
    })
  }, [count])

  const tick = useCallback(() => {
    setSeries(prev => {
      const next = source.sampleTraffic(prev[prev.length - 1] ?? 0)
      return next === null ? prev : [...prev.slice(1), next]
    })
  }, [])

  const latest = series[series.length - 1] ?? 0
  return { series, width, count, latest, tick, available }
}

/** Builds the `d` attribute for the line + the closed area path. */
export function pulsePaths(series: number[]) {
  const yOf = (v: number) => PULSE_HEIGHT - 8 - ((v - 800) / 800) * (PULSE_HEIGHT - 18)
  let d = ''
  series.forEach((v, i) => {
    d += `${i ? 'L' : 'M'}${i * STEP},${yOf(v).toFixed(1)}`
  })
  const area = `${d}L${(series.length - 1) * STEP},${PULSE_HEIGHT}L0,${PULSE_HEIGHT}Z`
  return { line: d, area }
}
