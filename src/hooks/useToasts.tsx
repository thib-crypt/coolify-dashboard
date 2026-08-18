import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export interface Toast {
  id: number
  message: string
  color: string
}

interface ToastApi {
  toasts: Toast[]
  toast: (message: string, color?: string) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

let seq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = useCallback((message: string, color = 'var(--t3)') => {
    setToasts(prev => [...prev, { id: ++seq, message, color }])
  }, [])

  const value = useMemo(() => ({ toasts, toast, dismiss }), [toasts, toast, dismiss])
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
