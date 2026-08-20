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
  /** resolves when Coolify has answered — the button's busy face follows it */
  onDeploy: () => Promise<unknown>
  /** absent when the BFF has no password: there is then nothing to sign out of */
  onSignOut?: () => void
}

export function Topbar({
  org, environments, environment, onEnvironmentChange,
  systemStatus, searchRef, onOpenPalette, onDeploy, onSignOut,
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
        {onSignOut ? (
          <button className="avatar" aria-label="Sign out" title="Sign out" onClick={onSignOut} />
        ) : (
          <span className="avatar" aria-hidden="true" />
        )}
      </div>
    </header>
  )
}
