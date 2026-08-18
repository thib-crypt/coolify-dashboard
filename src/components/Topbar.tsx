import type { EnvironmentName } from '../data'
import { DeployButton } from './DeployButton'
import { EnvSwitch } from './EnvSwitch'
import { IconSearch } from './icons'
import './Topbar.css'

interface Props {
  org: string
  environments: EnvironmentName[]
  environment: EnvironmentName
  onEnvironmentChange: (env: EnvironmentName) => void
  systemStatus: { ok: boolean; label: string }
  searchRef: React.RefObject<HTMLButtonElement | null>
  onOpenPalette: () => void
  onDeploy: () => void
}

export function Topbar({
  org, environments, environment, onEnvironmentChange,
  systemStatus, searchRef, onOpenPalette, onDeploy,
}: Props) {
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        <span className="org"><i aria-hidden="true" />{org}</span>
        <span className="sep">/</span>
        <EnvSwitch environments={environments} value={environment} onChange={onEnvironmentChange} />
      </nav>
      <div className="right">
        <div className="sys">
          <span
            className="dot dot--pulse"
            style={{ '--c': systemStatus.ok ? 'var(--ok)' : 'var(--warn)' } as React.CSSProperties}
          />
          <span>{systemStatus.label}</span>
        </div>
        <button className="searchchip" ref={searchRef} aria-label="Open command palette" onClick={onOpenPalette}>
          <IconSearch />
          Search<kbd>⌘K</kbd>
        </button>
        <DeployButton onDeploy={onDeploy} />
        <button className="avatar" aria-label="Account" />
      </div>
    </header>
  )
}
