import { useEffect, useRef, type ComponentType, type SVGProps } from 'react'
import { NavLink } from 'react-router'
import {
  IconActivity, IconApps, IconCalendar, IconOverview, IconServers, IconSettings, LogoMark,
} from './icons'
import './Rail.css'

interface RailItem {
  to: string
  label: string
  Icon: ComponentType<SVGProps<SVGSVGElement>>
  /** `/` matches everything, so only the root needs the exact rule */
  end?: boolean
}

/**
 * Databases had an icon here before there was a page behind it. Rather than a
 * button that does nothing, the rail now lists exactly what exists — and
 * `Schedule` replaces it, because the schedule is data the dashboard already
 * computes and had nowhere to show in full.
 */
const TOP: RailItem[] = [
  { to: '/', label: 'Overview', Icon: IconOverview, end: true },
  { to: '/applications', label: 'Applications', Icon: IconApps },
  { to: '/servers', label: 'Servers', Icon: IconServers },
  { to: '/deployments', label: 'Deployments', Icon: IconActivity },
  { to: '/schedule', label: 'Schedule', Icon: IconCalendar },
]

const BOTTOM: RailItem[] = [{ to: '/setup', label: 'Setup check', Icon: IconSettings }]

function RailButton({ item }: { item: RailItem }) {
  const { Icon, label, to, end } = item
  return (
    <NavLink
      to={to}
      end={end ?? false}
      className="rail-btn"
      aria-label={label}
      // `aria-current="page"` is what the stylesheet has always keyed on; NavLink
      // sets it itself, so the active state needed no new CSS.
    >
      <Icon />
      <span className="tip" role="tooltip">{label}</span>
    </NavLink>
  )
}

/** Tooltips wait 450 ms on the first hover, then stay instant while the rail is "warm". */
export function Rail() {
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
      {TOP.map(item => <RailButton key={item.to} item={item} />)}
      <div className="spacer" />
      {BOTTOM.map(item => <RailButton key={item.to} item={item} />)}
    </aside>
  )
}
