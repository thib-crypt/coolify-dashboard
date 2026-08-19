import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createActionService, readApplicationAction, readDeployResponse } from './actions'
import { TtlCache } from './cache'
import { CoolifyError, type CoolifyClient } from './coolify/client'

/** Only the write half is exercised here; reads throw if a test touches them. */
function stubClient(overrides: Partial<CoolifyClient>): CoolifyClient {
  return new Proxy({ ...overrides } as CoolifyClient, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof CoolifyClient]
      throw new Error(`unexpected client call: ${prop}`)
    },
  })
}

describe('readDeployResponse', () => {
  it('reports a queued deployment with the uuid to follow', () => {
    assert.deepEqual(
      readDeployResponse({
        deployments: [
          { message: 'Application api deployment queued.', resource_uuid: 'a1', deployment_uuid: 'd1' },
        ],
      }),
      { outcome: 'queued', message: 'Application api deployment queued.', deploymentUuid: 'd1' },
    )
  })

  it('does not celebrate a skip, and drops the uuid it never queued', () => {
    // Coolify returns the id it had just generated even though nothing was queued.
    const result = readDeployResponse({
      deployments: [
        { message: 'Deployment already queued for this commit.', resource_uuid: 'a1', deployment_uuid: 'unused' },
      ],
    })
    assert.equal(result.outcome, 'skipped')
    assert.equal(result.deploymentUuid, undefined)
  })

  it('turns the 200-with-refusal into a permission error', () => {
    assert.throws(
      () => readDeployResponse({ deployments: [{ message: 'Unauthorized to deploy this application.' }] }),
      (error: unknown) => error instanceof CoolifyError && error.code === 'forbidden',
    )
  })

  it('treats a bodiless answer as a skip rather than a success', () => {
    assert.deepEqual(readDeployResponse({ message: 'No resources found.' }), {
      outcome: 'skipped',
      message: 'No resources found.',
    })
  })
})

describe('readApplicationAction', () => {
  it('queues when start/restart answered with a deployment', () => {
    assert.deepEqual(readApplicationAction({ message: 'Restart request queued.', deployment_uuid: 'd2' }, true), {
      outcome: 'queued',
      message: 'Restart request queued.',
      deploymentUuid: 'd2',
    })
  })

  it('skips when the deployment was collapsed into a running one', () => {
    assert.equal(readApplicationAction({ message: 'Deployment already queued.' }, true).outcome, 'skipped')
  })

  it('calls stop done — it never creates a deployment', () => {
    assert.deepEqual(readApplicationAction({ message: 'Application stopping request queued.' }, false), {
      outcome: 'done',
      message: 'Application stopping request queued.',
    })
  })
})

describe('createActionService', () => {
  it('drops the cached deployments so the next overview sees the new one', async () => {
    const cache = new TtlCache()
    let loads = 0
    const load = async () => ++loads
    await cache.fetch('deployments:running', 60_000, load)
    await cache.fetch('deployments:app-1', 60_000, load)

    const service = createActionService({
      cache,
      client: stubClient({
        deploy: async () => ({ deployments: [{ message: 'Application api deployment queued.', deployment_uuid: 'd1' }] }),
      }),
    })

    assert.equal((await service.deploy('app-1')).outcome, 'queued')
    await cache.fetch('deployments:running', 60_000, load)
    await cache.fetch('deployments:app-1', 60_000, load)
    assert.equal(loads, 4, 'both deployment entries should have been reloaded')
  })

  it('drops the cached application detail the auto-deploy toggle reads back', async () => {
    const cache = new TtlCache()
    let loads = 0
    const load = async () => ++loads
    await cache.fetch('application:app-1', 60_000, load)
    await cache.fetch('application:app-2', 60_000, load)

    const patched: unknown[] = []
    const service = createActionService({
      cache,
      client: stubClient({
        patchApplication: async (_uuid, body) => { patched.push(body) },
      }),
    })

    const result = await service.setAutoDeploy('app-1', false)
    assert.deepEqual(patched, [{ is_auto_deploy_enabled: false }])
    assert.deepEqual(result, { outcome: 'done', message: 'Auto-deploy disabled.' })

    await cache.fetch('application:app-1', 60_000, load)
    await cache.fetch('application:app-2', 60_000, load)
    assert.equal(loads, 3, 'only the patched application should have been reloaded')
  })
})
