import { useEffect, useRef, useState } from 'react'
import type { PaletteAction } from '../data'
import { PaletteIcon } from './icons'
import './CommandPalette.css'

interface Props {
  open: boolean
  actions: PaletteAction[]
  onClose: () => void
  onRun: (action: PaletteAction) => void
}

/** Keyboard-initiated, so it opens instantly — no entrance animation on purpose. */
export function CommandPalette({ open, actions, onClose, onRun }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const items = actions.filter(a => a.title.toLowerCase().includes(query.trim().toLowerCase()))

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    input.current?.focus()
  }, [open])

  // keep the highlighted row in view when navigating with the keyboard
  useEffect(() => {
    if (!open) return
    list.current?.querySelectorAll('.pal-item')[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected, open])

  const run = (index = selected) => {
    const action = items[index]
    if (!action) return
    onClose()
    onRun(action)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected(s => (items.length ? (s + 1 + items.length) % items.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected(s => (items.length ? (s - 1 + items.length) % items.length : 0))
      } else if (e.key === 'Enter') run()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (!open) return null

  return (
    <>
      <div className="veil" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          type="text"
          placeholder="Type a command or search…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={e => { setQuery(e.target.value); setSelected(0) }}
        />
        <div className="pal-list" ref={list} role="listbox">
          {items.length ? (
            items.map((action, i) => (
              <button
                key={action.id}
                className="pal-item"
                role="option"
                aria-selected={i === selected}
                onClick={() => run(i)}
                onMouseMove={() => { if (i !== selected) setSelected(i) }}
              >
                <PaletteIcon name={action.icon} />
                {action.title}
                {action.shortcut && <kbd>{action.shortcut}</kbd>}
              </button>
            ))
          ) : (
            <div className="pal-empty">No results for “{query}”</div>
          )}
        </div>
        <div className="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd>navigate</span>
          <span><kbd>↵</kbd>run</span>
          <span><kbd>esc</kbd>close</span>
        </div>
      </div>
    </>
  )
}
