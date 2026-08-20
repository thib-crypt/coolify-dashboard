/**
 * Write side of the BFF (phase 2 of docs/roadmap.md).
 *
 * Two things make this more than a passthrough:
 *
 *  1. **Coolify answers 200 for outcomes that are not successes.** A deploy that
 *     was skipped, and even one the token was not allowed to run, both come back
 *     as `200 {"deployments":[{"message":"…"}]}` — the message is the only
 *     signal (`DeployController::deploy_resource`). The readers below turn that
 *     into an explicit `ActionOutcome` instead of letting the UI cheer for a
 *     no-op.
 *  2. **A write invalidates what the reads cached.** Without this, a deployment
 *     triggered here would not show up in `/app/overview` for another 5 s (and
 *     an auto-deploy toggle for another 5 min), which reads as "the click did
 *     nothing".
 */

import type { ActionResponse } from '../shared/bff'
import type * as Api from '../shared/coolify-api'
import type { TtlCache } from './cache'
import { CoolifyError, type ApplicationAction, type CoolifyClient, type TaskOwner } from './coolify/client'

/** Strings `queue_application_deployment()` and `deploy_resource()` return. */
const REFUSED = /^unauthorized/i
const SKIPPED = /already queued|skipped/i

/**
 * Reads `POST /deploy`.
 *
 * Careful with `deployment_uuid`: on a skip, Coolify returns the id it had just
 * generated and never used — it points at no deployment at all, so it is dropped
 * rather than handed to the UI as something to follow.
 */
export function readDeployResponse(body: Api.DeployResponse): ActionResponse {
  const entry = body.deployments?.[0]
  const message = entry?.message ?? body.message ?? 'Coolify accepted the request.'

  if (REFUSED.test(message)) {
    throw new CoolifyError(message, { code: 'forbidden', status: 200, path: '/deploy' })
  }
  if (!entry || SKIPPED.test(message)) return { outcome: 'skipped', message }

  return {
    outcome: 'queued',
    message,
    ...(entry.deployment_uuid ? { deploymentUuid: entry.deployment_uuid } : {}),
  }
}

/**
 * Reads `POST /applications/{uuid}/{start,restart,stop}`.
 *
 * `start` and `restart` queue a deployment and say so with a `deployment_uuid`;
 * its absence means the deployment was skipped. `stop` never has one — it is
 * dispatched immediately.
 */
export function readApplicationAction(
  body: Api.StartApplicationResponse,
  queues: boolean,
): ActionResponse {
  const message = body.message ?? 'Coolify accepted the request.'
  if (!queues) return { outcome: 'done', message }
  return body.deployment_uuid
    ? { outcome: 'queued', message, deploymentUuid: body.deployment_uuid }
    : { outcome: 'skipped', message }
}

/**
 * Reads `POST /applications/{uuid}/rollback`.
 *
 * Same 200-means-nothing trap as `/deploy` — a skipped rollback answers 200 with
 * a message and no `deployment_uuid`. Different in one place worth remembering:
 * a full deployment queue here is a **400**, not the 429 the deploy route uses,
 * so it arrives as `bad_request` and its message is the only thing that says so.
 */
export function readRollbackResponse(body: Api.RollbackResponse): ActionResponse {
  const message = body.message ?? 'Coolify accepted the request.'
  if (REFUSED.test(message)) {
    throw new CoolifyError(message, { code: 'forbidden', status: 200, path: '/rollback' })
  }
  return body.deployment_uuid
    ? { outcome: 'queued', message, deploymentUuid: body.deployment_uuid }
    : { outcome: 'skipped', message }
}

export interface ActionDeps {
  client: CoolifyClient
  cache: TtlCache
}

export interface ActionService {
  deploy(uuid: string, options?: { force?: boolean }): Promise<ActionResponse>
  cancelDeployment(uuid: string): Promise<ActionResponse>
  applicationAction(uuid: string, action: ApplicationAction): Promise<ActionResponse>
  setAutoDeploy(uuid: string, enabled: boolean): Promise<ActionResponse>
  runScheduledTask(owner: TaskOwner, ownerUuid: string, taskUuid: string): Promise<ActionResponse>
  /** Redeploys an image already on the server; `commit` is its tag. */
  rollback(uuid: string, commit: string): Promise<ActionResponse>
}

export function createActionService({ client, cache }: ActionDeps): ActionService {
  /** Anything that touches the deployment queue: running list *and* histories. */
  const forgetDeployments = () => cache.invalidate('deployments')

  return {
    async deploy(uuid, options) {
      const result = readDeployResponse(await client.deploy(uuid, options))
      forgetDeployments()
      return result
    },

    async rollback(uuid, commit) {
      const result = readRollbackResponse(await client.rollback(uuid, commit))
      forgetDeployments()
      // The running image changes, and with it which target is `current`.
      cache.invalidate(`rollback:${uuid}`)
      return result
    },

    async cancelDeployment(uuid) {
      const body = await client.cancelDeployment(uuid)
      forgetDeployments()
      return { outcome: 'done', message: body.message ?? 'Deployment cancelled.' }
    },

    async applicationAction(uuid, action) {
      const result = readApplicationAction(await client.applicationAction(uuid, action), action !== 'stop')
      forgetDeployments()
      // A stopped or restarted container changes the status the list endpoint reports.
      cache.invalidate('applications')
      cache.invalidate(`application:${uuid}`)
      return result
    },

    async setAutoDeploy(uuid, enabled) {
      await client.patchApplication(uuid, { is_auto_deploy_enabled: enabled })
      // The toggle reads back from the per-application detail, cached for 5 min.
      cache.invalidate(`application:${uuid}`)
      return {
        outcome: 'done',
        message: `Auto-deploy ${enabled ? 'enabled' : 'disabled'}.`,
      }
    },

    async runScheduledTask(owner, ownerUuid, taskUuid) {
      const body = await client.runScheduledTask(owner, ownerUuid, taskUuid)
      return { outcome: 'queued', message: body.message ?? 'Scheduled task execution queued.' }
    },
  }
}
