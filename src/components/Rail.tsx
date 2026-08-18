import { useEffect, useRef, type ComponentType, type SVGProps } from 'react'
import {
  IconActivity, IconApps, IconDatabases, IconOverview, IconServers, IconSettings, LogoMark,
} from './icons'
import './Rail.css'

interface RailItem {
  id: string
  label: string
  Icon: ComponentType<SVGProps<SVGSVGElement>>
}

const TOP: RailItem[] = [
  { id: 'overview', label: 'Overview', Icon: IconOverview },
  { id: 'applications', label: 'Applications', Icon: IconApps },
  { id: 'servers', label: 'Servers', Icon: IconServers },
  { id: 'databases', label: 'Databases', Icon: IconDatabases },
  { id: 'activity', label: 'Activity', Icon: IconActivity },
]

const BOTTOM: RailItem[] = [{ id: 'settings', label: 'Settings', Icon: IconSettings }]

function RailButton({ item, current }: { item: RailItem; current: boolean }) {
  const { Icon, label } = item
  return (
    <button className="rail-btn" aria-current={current ? 'page' : undefined} aria-label={label}>
      <Icon />
      <span className="tip" role="tooltip">{label}</span>
    </button>
  )
}

/** Tooltips wait 450 ms on the first hover, then stay instant while the rail is "warm". */
export function Rail({ current = 'overview' }: { current?: string }) {
  const rail = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = rail.current
    if (!el) return
    let warmTimer: number | undefined
    let coolTimer: number | undefined

    const onOver = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.rail-btn')) {
        clearTimeout(warmTimer)
        warmTimer = window.setTimeout(() => el.classList.add('warm'), 450)
      }
    }
    const onLeave = () => {
      clearTimeout(warmTimer)
      coolTimer = window.setTimeout(() => el.classList.remove('warm'), 250)
    }

    el.addEventListener('mouseover', onOver)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      clearTimeout(warmTimer)
      clearTimeout(coolTimer)
      el.removeEventListener('mouseover', onOver)
      el.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  return (
    <aside className="rail" ref={rail} aria-label="Navigation">
      <div className="logo" aria-hidden="true"><LogoMark /></div>
      {TOP.map(item => <RailButton key={item.id} item={item} current={item.id === current} />)}
      <div className="spacer" />
      {BOTTOM.map(item => <RailButton key={item.id} item={item} current={item.id === current} />)}
    </aside>
  )
}
