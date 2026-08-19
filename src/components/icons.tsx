/* Every icon is lifted verbatim from the mockup — same paths, same stroke widths. */
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

const stroke = (props: P, width = 1.7, join = true) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: width,
  strokeLinecap: 'round' as const,
  ...(join ? { strokeLinejoin: 'round' as const } : {}),
  ...props,
})

export const LogoMark = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M17.5 19a4.5 4.5 0 1 0-.42-8.98 6 6 0 1 0-11.06 3.32A3.5 3.5 0 0 0 7 19.5z" />
  </svg>
)

export const IconOverview = (p: P) => (
  <svg {...stroke(p)}><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 9.5V20h13V9.5" /></svg>
)

export const IconApps = (p: P) => (
  <svg {...stroke(p, 1.7, false)}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
  </svg>
)

export const IconServers = (p: P) => (
  <svg {...stroke(p, 1.7, false)}>
    <rect x="4" y="5" width="16" height="6" rx="1.5" />
    <rect x="4" y="13" width="16" height="6" rx="1.5" />
    <path d="M7.5 8h.01M7.5 16h.01" />
  </svg>
)

export const IconDatabases = (p: P) => (
  <svg {...stroke(p, 1.7, false)}>
    <ellipse cx="12" cy="6" rx="7" ry="2.8" />
    <path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6" />
    <path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" />
  </svg>
)

export const IconActivity = (p: P) => (
  <svg {...stroke(p)}><path d="M3 12h4l2.5-6 4.5 12 2.5-6H21" /></svg>
)

export const IconSettings = (p: P) => (
  <svg {...stroke(p, 1.7, false)}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" />
  </svg>
)

export const IconDeployments = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M12 3.5v11M8 7.5l4-4 4 4" />
    <path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" />
  </svg>
)

export const IconLatency = (p: P) => (
  <svg {...stroke(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
)

export const IconCost = (p: P) => (
  <svg {...stroke(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M14.5 9.2c-.5-.9-1.5-1.4-2.6-1.4-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2 2.7.8 2.7 2.1-1.2 2.1-2.7 2.1c-1.2 0-2.2-.5-2.7-1.5M12 6.4v11.2" />
  </svg>
)

export const IconSearch = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" {...p}>
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
  </svg>
)

export const IconCheckMark = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
)

export const IconFilters = (p: P) => (
  <svg {...stroke(p, 1.8)}><path d="M4 6h16M7 12h10M10 18h4" /></svg>
)

export const IconCalendar = (p: P) => (
  <svg {...stroke(p, 1.8)}>
    <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
    <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
  </svg>
)

export const IconCaretUp = (p: P) => (
  <svg viewBox="0 0 10 10" fill="currentColor" {...p}><path d="M5 1l4 5H1z" /></svg>
)

export const IconChevron = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)

export const IconBranch = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...p}>
    <circle cx="6" cy="6" r="2.6" /><circle cx="6" cy="18" r="2.6" /><circle cx="18" cy="8" r="2.6" />
    <path d="M6 8.6v6.8M18 10.6c0 4-5 3.4-8 5" />
  </svg>
)

export const IconStatusOk = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 5-6" />
  </svg>
)

export const IconStatusErr = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" {...p}>
    <circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" />
  </svg>
)

/* ————— command palette icons (same 1.7 stroke as the mockup) */
const PALETTE_PATHS = {
  rocket: <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2m-1-6.5C8.5 7 12 3.5 17.5 3c.5 0 1 .5 1 1-.5 5.5-4 9-8.5 10.5L7 11.5zM14 9a1.5 1.5 0 1 0 .01 0z" />,
  rotate: <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  clock: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2" />,
  logs: <path d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h4" />,
  server: (
    <>
      <rect x="4" y="5" width="16" height="6" rx="1.5" />
      <rect x="4" y="13" width="16" height="6" rx="1.5" />
      <path d="M7.5 8h.01M7.5 16h.01" />
    </>
  ),
  swap: <path d="M7 8h13m0 0-3.5-3.5M20 8l-3.5 3.5M17 16H4m0 0 3.5-3.5M4 16l3.5 3.5" />,
  shield: <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />,
  db: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.8" />
      <path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" />
    </>
  ),
  ghost: <path d="M12 3a7 7 0 0 0-7 7v10l2.5-2 2.5 2 2.5-2 2.5 2 2.5-2 2.5 2V10a7 7 0 0 0-7-7z" />,
} as const

export type PaletteIconKey = keyof typeof PALETTE_PATHS

export const PaletteIcon = ({ name, ...p }: P & { name: PaletteIconKey }) => (
  <svg {...stroke(p)}>{PALETTE_PATHS[name]}</svg>
)

export const KPI_ICONS = {
  apps: IconApps,
  deployments: IconDeployments,
  latency: IconLatency,
  cost: IconCost,
} as const
