import { useSyncExternalStore } from 'react'

const query = () => matchMedia('(prefers-reduced-motion: reduce)')

const subscribe = (cb: () => void) => {
  const mq = query()
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

export const useReducedMotion = () =>
  useSyncExternalStore(subscribe, () => query().matches, () => false)
