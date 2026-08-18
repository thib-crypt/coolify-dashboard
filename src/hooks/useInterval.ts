import { useEffect, useRef } from 'react'

/** setInterval that always calls the latest callback and never re-arms on re-render. */
export function useInterval(callback: () => void, delay: number | null) {
  const saved = useRef(callback)
  saved.current = callback

  useEffect(() => {
    if (delay === null) return
    const id = setInterval(() => saved.current(), delay)
    return () => clearInterval(id)
  }, [delay])
}
