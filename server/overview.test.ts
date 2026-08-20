import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TtlCache } from './cache'
import { CoolifyError, type CoolifyClient } from './coolify/client'
import { createOverviewService } from './overview'
import type { SnapshotStore } from './store'
import type * as Api from '../shared/coolify-api'

/** Reads only; an unstubbed call throws rather than answering vaguely. */
function stubClient(overrides: Partial<CoolifyClient>): CoolifyClient {
  return new Proxy({ ...overrides } as CoolifyClient, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof CoolifyClient]
      throw new Error(`unexpected client call: ${prop}`)
    },
  })
}

/** `build` is the only method that touches the store; these tests do not. */
const store: SnapshotStore = {
  kind: 'memory',
  record: () => false,
  history: () => [],
  before: () => null,
  close: () => {},
}

const application = (over: Partial<Api.Application> = {}): Api.Application => ({
  uuid: 'app-1',
  name: 'api-core',
  fqdn: 'https://api.example.com',
  git_repository: 'acme/api',
  git_branch: 'main',
  build_pack: 'nixpacks',
  status: 'running:healthy',
  environment_id: 1,
  server_id: 7,
  ...over,
})

const deployment = (over: Partial<Api.ApplicationDeploymentQueue>): Api.ApplicationDeploymentQueue => ({
  id: 1,
  deployment_uuid: 'd1',
  application_name: 'api-core',
  status: 'finished',
  created_at: '2026-08-20 10:00:00',
  finished_at: '2026-08-20 10:01:00',
  ...over,
})

/** The families every page-level read resolves before doing its own work. */
const scope = {
  team: async () => ({ name: 'Acme' }) as Api.Team,
  projects: async () => [{ uuid: 'p1', name: 'Orbit' }] as Api.Project[],
  environments: async () => [{ id: 1, uuid: 'e1', name: 'production' }] as Api.Environment[],
  servers: async () => [{ id: 7, uuid: 's1', name: 'hetzner-fsn1' }] as Api.Server[],
}

const service = (overrides: Partial<CoolifyClient>) =>
  createOverviewService({
    client: stubClient({ ...scope, ...overrides }),
    cache: new TtlCache(),
    store,
    historyTake: 20,
    coolifyUrl: 'https://coolify.test',
    now: () => Date.UTC(2026, 7, 20, 12, 0, 0),
  })

describe('history', () => {
  const client = {
    applications: async () => [application(), application({ uuid: 'app-2', name: 'docs' })],
    applicationDeployments: async (uuid: string) =>
      ({
        deployments:
          uuid === 'app-1'
            ? [
                deployment({ deployment_uuid: 'a', finished_at: '2026-08-20 11:00:00' }),
                deployment({ deployment_uuid: 'b', finished_at: '2026-08-20 09:00:00' }),
              ]
            : [deployment({ deployment_uuid: 'c', application_name: 'docs', finished_at: '2026-08-20 10:00:00' })],
      }) as Api.ApplicationDeploymentsPage,
  }

  it('merges every application into one list, newest first', async () => {
    const page = await service(client).history({ env: null, skip: 0, take: 50 })

    assert.equal(page.total, 3)
    // Coolify pages each application separately, so the ordering across them
    // only exists because it is rebuilt here.
    assert.deepEqual(page.deployments.map(entry => entry.id), ['a', 'c', 'b'])
    assert.equal(page.environment, 'production')
  })

  it('pages the merged list rather than each application', async () => {
    const page = await service(client).history({ env: null, skip: 1, take: 1 })

    assert.deepEqual(page.deployments.map(entry => entry.id), ['c'])
    assert.equal(page.total, 3)
    assert.equal(page.skip, 1)
  })

  it('narrows to one application when asked', async () => {
    const page = await service(client).history({ env: null, skip: 0, take: 50, application: 'app-2' })

    assert.deepEqual(page.deployments.map(entry => entry.id), ['c'])
  })

  it('says what bounds it, since the ceiling is a setting and not the truth', async () => {
    const page = await service(client).history({ env: null, skip: 0, take: 50 })
    assert.ok(page.notes.some(note => /DEPLOYMENT_HISTORY_TAKE/.test(note.reason)))
  })

  it('shows nothing, and says so, for an application of another environment', async () => {
    const page = await service(client).history({ env: null, skip: 0, take: 50, application: 'nope' })

    assert.deepEqual(page.deployments, [])
    assert.ok(page.notes.some(note => /not in this environment/.test(note.reason)))
  })
})

describe('detail', () => {
  const base = {
    applications: async () => [application()],
    application: async () => application({ settings: { is_auto_deploy_enabled: true } }),
  }

  it('describes the application, its environment and its server', async () => {
    const detail = await service({
      ...base,
      applicationEnvs: async () => [],
      rollbackImages: async () => ({ current: null, images: [] }),
    }).detail('app-1')

    assert.equal(detail.name, 'api-core')
    assert.equal(detail.domain, 'api.example.com')
    assert.deepEqual(detail.status, { state: 'running', health: 'healthy' })
    assert.equal(detail.autoDeploy, true)
    assert.equal(detail.environment, 'production')
    assert.equal(detail.serverName, 'hetzner-fsn1')
    assert.equal(detail.link, 'https://coolify.test/project/p1/environment/e1/application/app-1')
  })

  it('separates a value withheld from one Coolify never returns', async () => {
    const detail = await service({
      ...base,
      applicationEnvs: async () => [
        { uuid: 'e1', key: 'NODE_ENV', value: 'production' },
        // absent `value`: no `read:sensitive`
        { uuid: 'e2', key: 'DATABASE_URL' },
        { uuid: 'e3', key: 'SECRET', is_shown_once: true },
      ],
      rollbackImages: async () => ({ current: null, images: [] }),
    }).detail('app-1')

    assert.deepEqual(detail.envs, [
      { key: 'NODE_ENV', value: 'production', writeOnly: false, buildTime: false, preview: false },
      { key: 'DATABASE_URL', value: null, writeOnly: false, buildTime: false, preview: false },
      { key: 'SECRET', value: null, writeOnly: true, buildTime: false, preview: false },
    ])
  })

  it('names the missing ability when every value came back withheld', async () => {
    const detail = await service({
      ...base,
      applicationEnvs: async () => [{ uuid: 'e1', key: 'A' }, { uuid: 'e2', key: 'B' }],
      rollbackImages: async () => ({ current: null, images: [] }),
    }).detail('app-1')

    assert.ok(detail.notes.some(note => /read:sensitive/.test(note.reason)))
  })

  it('keeps only tagged rollback targets, and flags the running one', async () => {
    const detail = await service({
      ...base,
      applicationEnvs: async () => [],
      rollbackImages: async () => ({
        current: 'a1f4c92',
        images: [
          { tag: 'a1f4c92', created_at: '2026-08-20 12:04:11', is_current: true },
          { tag: '9d2b710', created_at: '2026-08-19 17:41:02' },
          // an untagged image cannot be asked for: `commit` is the tag
          { tag: null, created_at: '2026-08-18 10:00:00' },
        ],
      }),
    }).detail('app-1')

    assert.deepEqual(detail.rollback.targets.map(target => target.tag), ['a1f4c92', '9d2b710'])
    assert.equal(detail.rollback.targets[0]?.current, true)
    assert.equal(detail.rollback.current, 'a1f4c92')
  })

  it('explains an empty rollback list rather than implying there is nothing', async () => {
    const detail = await service({
      ...base,
      applicationEnvs: async () => [],
      // What an unreachable server answers — with a 200.
      rollbackImages: async () => ({ current: null, images: [] }),
    }).detail('app-1')

    assert.ok(detail.notes.some(note => /unreachable server also answers an empty list/.test(note.reason)))
  })

  it('still describes the application when the extras fail', async () => {
    const detail = await service({
      ...base,
      applicationEnvs: async () => {
        throw new CoolifyError('Forbidden', { code: 'forbidden', status: 403 })
      },
      rollbackImages: async () => {
        throw new CoolifyError('Server Error', { code: 'http', status: 500 })
      },
    }).detail('app-1')

    assert.equal(detail.name, 'api-core')
    assert.deepEqual(detail.envs, [])
    assert.equal(detail.notes.length > 0, true)
  })
})

describe('logs', () => {
  it('splits the container output into lines', async () => {
    const answer = await service({
      applicationLogs: async () => ({ logs: 'listening on :3000\nready\n' }),
    }).logs('app-1', 200)

    assert.deepEqual(answer, { lines: ['listening on :3000', 'ready'], note: null })
  })

  it('treats a stopped container as a state, not an error', async () => {
    const answer = await service({
      applicationLogs: async () => {
        // Coolify's actual answer for a stopped application.
        throw new CoolifyError('Application is not running.', { code: 'bad_request', status: 400 })
      },
    }).logs('app-1', 200)

    assert.deepEqual(answer, { lines: [], note: 'Application is not running.' })
  })

  it('says so when the container is running but silent', async () => {
    const answer = await service({ applicationLogs: async () => ({ logs: '' }) }).logs('app-1', 200)

    assert.deepEqual(answer.lines, [])
    assert.match(answer.note ?? '', /written nothing yet/)
  })

  it('does not swallow a genuine failure', async () => {
    await assert.rejects(
      () =>
        service({
          applicationLogs: async () => {
            throw new CoolifyError('Cannot reach Coolify', { code: 'unreachable' })
          },
        }).logs('app-1', 200),
      (error: unknown) => error instanceof CoolifyError && error.code === 'unreachable',
    )
  })

  it('clamps the line count it asks for', async () => {
    let asked = 0
    const client = { applicationLogs: async (_uuid: string, lines: number) => { asked = lines; return { logs: 'x' } } }

    await service(client).logs('app-1', 100_000)
    assert.equal(asked, 500)
    await service(client).logs('app-1', 0)
    assert.equal(asked, 1)
  })
})
