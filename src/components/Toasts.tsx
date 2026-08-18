import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useToast, type Toast as ToastData } from '../hooks/useToasts'
import './Toasts.css'

function Toast({ toast, onDone }: { toast: ToastData; onDone: (id: number) => void }) {
  const [state, setState] = useState<'' | 'in' | 'out'>('')

  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setState('in')))
    const id = setTimeout(() => setState('out'), 3600)
    return () => { cancelAnimationFrame(raf); clearTimeout(id) }
  }, [])

  return (
    <div
      className={`toast${state ? ` ${state}` : ''}`}
      onTransitionEnd={() => { if (state === 'out') onDone(toast.id) }}
    >
      <span className="dot" style={{ '--c': toast.color } as CSSProperties} />
      {toast.message}
    </div>
  )
}

export function Toasts() {
  const { toasts, dismiss } = useToast()
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map(t => <Toast key={t.id} toast={t} onDone={dismiss} />)}
    </div>
  )
}
