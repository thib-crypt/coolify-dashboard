import type { Deployment } from '../data'
import { Panel } from './Panel'
import { LiveDeployment } from './LiveDeployment'
import { IconBranch, IconStatusErr, IconStatusOk } from './icons'
import './DeploymentsPanel.css'

interface Props {
  deployments: Deployment[]
  count: number
  index?: number
  onCancel: (deployment: Deployment) => void | Promise<void>
  onViewAll: (label: string) => void
}

function FinishedRow({ deployment }: { deployment: Deployment }) {
  const Status = deployment.state === 'failed' ? IconStatusErr : IconStatusOk
  return (
    <div className="dep">
      <Status className={`status-ico ${deployment.state === 'failed' ? 'err' : 'ok'}`} />
      <div className="info">
        <div className="l1">
          <span className="app">{deployment.app}</span>
          <span className="msg">{deployment.message}</span>
        </div>
        <div className="l2">
          <span className="branch"><IconBranch />{deployment.branch}</span>
          <span className="sha">{deployment.sha}</span>
        </div>
      </div>
      <div className="right">
        <span className="dur num">{deployment.duration}</span>
        <span className="when num">{deployment.when}</span>
      </div>
    </div>
  )
}

export function DeploymentsPanel({ deployments, count, index, onCancel, onViewAll }: Props) {
  return (
    <Panel
      title="Deployments"
      label="Deployments"
      count={count}
      index={index}
      more={{ label: 'View all', onClick: onViewAll }}
    >
      {deployments.map(d =>
        d.state === 'running'
          ? <LiveDeployment key={d.id} deployment={d} onCancel={onCancel} />
          : <FinishedRow key={d.id} deployment={d} />,
      )}
    </Panel>
  )
}
