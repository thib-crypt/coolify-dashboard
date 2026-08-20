import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_SESSION_TTL_MS } from './auth'
import type { BffConfig } from './config'
import { CoolifyError, type CoolifyClient } from './coolify/client'
import { DEFAULT_METRICS_CONFIG } from './metrics'
import { DEFAULT_PROBE_CONFIG } from './probes'
import { runSetupChecks, type SetupCheck, type SetupDeps } from './setup'

/** Reads only; anything a test did not stub throws rather than answering vaguely. */
function stubClient(overrides: Partial<CoolifyClient>): CoolifyClient {
  return new Proxy({ ...overrides } as CoolifyClient, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof CoolifyClient]
      throw new Error(`unexpected client call: ${prop}`)
    },
  })
}

const config = (over: Partial<BffConfig> = {}): BffConfig => ({
  coolifyUrl: 'https://coolify.test',
  coolifyToken: 'token',
  port: 8787,
  host: '127.0.0.1',
  staticDir: null,
  dataDir: '/data',
  requestTimeoutMs: 1000,
  deploymentHistoryTake: 20,
  webhookSecret: 'secret',
  pollActiveMs: 2500,
  pollIdleMs: 4000,
  probes: { ...DEFAULT_PROBE_CONFIG },
  metrics: { ...DEFAULT_METRICS_CONFIG, enabled: true, sshKeyPath: '/keys/id' },
  auth: { password: 'hunter2', sessionSecret: null, sessionTtlMs: DEFAULT_SESSION_TTL_MS },
  ...over,
})

/** A healthy instance: everything answers, every ability is granted. */
const healthyClient = () =>
  stubClient({
    version: async () => 'v4.3.2\n',
    team: async () => ({ name: 'Acme' }) as never,
    servers: async () => [{ uuid: 's1' }] as never,
    serverSentinel: async () => ({ sentinel_token: 'st' }) as never,
    abilityProbe: async () => ({ granted: true, reason: 'granted', message: 'Granted.' }),
  })

const deps = (over: Partial<SetupDeps> = {}): SetupDeps => ({
  config: config(),
  client: healthyClient(),
  storeKind: 'sqlite',
  passwordSet: true,
  now: () => Date.UTC(2026, 7, 20),
  ...over,
})

const find = (checks: SetupCheck[], id: string): SetupCheck => {
  const check = checks.find(entry => entry.id === id)
  assert.ok(check, `no check with id ${id}`)
  return check
}

describe('runSetupChecks', () => {
  it('passes everything on a fully configured instance', async () => {
    const report = await runSetupChecks(deps())

    assert.equal(report.ok, true)
    assert.equal(report.version, 'v4.3.2')
    assert.equal(report.team, 'Acme')
    assert.equal(report.generatedAt, '2026-08-20T00:00:00.000Z')
    assert.deepEqual(
      report.checks.filter(check => check.status !== 'ok'),
      [],
    )
  })

  it('stops at the first wall: no configuration means nothing to ask', async () => {
    const report = await runSetupChecks(
      deps({ config: config({ coolifyUrl: null, coolifyToken: null }), client: null }),
    )

    assert.equal(report.ok, false)
    const check = find(report.checks, 'config')
    assert.equal(check.status, 'fail')
    assert.match(check.detail, /COOLIFY_URL and COOLIFY_TOKEN are not set/)
    // No point reporting five `unknown`s that all say "because of the above".
    assert.equal(report.checks.some(entry => entry.id === 'reachable'), false)
  })

  it('separates a revoked token from an unreachable instance', async () => {
    const report = await runSetupChecks(
      deps({
        client: stubClient({
          version: async () => {
            throw new CoolifyError('Invalid token.', { code: 'unauthorized', status: 400 })
          },
        }),
      }),
    )

    const check = find(report.checks, 'reachable')
    assert.equal(check.status, 'fail')
    assert.match(check.detail, /400 "Invalid token\.", not 401/)
    assert.equal(check.link, 'https://coolify.test/security/api-tokens')
    assert.equal(report.ok, false)
  })

  it('separates a disabled API from a blocked IP — both are 403 upstream', async () => {
    for (const [code, expected] of [
      ['api_disabled', /switched off/],
      ['ip_blocked', /allowlist/],
    ] as const) {
      const report = await runSetupChecks(
        deps({
          client: stubClient({
            version: async () => {
              throw new CoolifyError('…', { code, status: 403 })
            },
          }),
        }),
      )
      const check = find(report.checks, 'reachable')
      assert.match(check.detail, expected, code)
      assert.equal(check.link, 'https://coolify.test/settings/advanced', code)
    }
  })

  it('reports a missing ability as a warning, not a failure', async () => {
    const report = await runSetupChecks(
      deps({
        client: stubClient({
          version: async () => 'v4.3.2',
          team: async () => ({ name: 'Acme' }) as never,
          servers: async () => [{ uuid: 's1' }] as never,
          serverSentinel: async () => ({ sentinel_token: 'st' }) as never,
          abilityProbe: async ability =>
            ability === 'deploy'
              ? { granted: false, reason: 'missing', message: 'Missing required permissions: deploy' }
              : { granted: true, reason: 'granted', message: 'Granted.' },
        }),
      }),
    )

    const check = find(report.checks, 'ability-deploy')
    assert.equal(check.status, 'warn')
    assert.match(check.hint ?? '', /Tick `deploy`/)
    // A read-only token renders the whole dashboard: this is a choice, not a fault.
    assert.equal(report.ok, true)
  })

  it('tells a member-level token owner to fix the role, not the checkbox', async () => {
    const report = await runSetupChecks(
      deps({
        client: stubClient({
          version: async () => 'v4.3.2',
          team: async () => ({ name: 'Acme' }) as never,
          servers: async () => [{ uuid: 's1' }] as never,
          serverSentinel: async () => ({ sentinel_token: 'st' }) as never,
          abilityProbe: async () => ({
            granted: false,
            reason: 'role',
            message: 'This API token has permissions (deploy) that exceed your current role as a team member.',
          }),
        }),
      }),
    )

    assert.match(find(report.checks, 'ability-deploy').hint ?? '', /admin or owner of the team/)
  })

  it('reads read:sensitive from the field Coolify withholds without it', async () => {
    const withheld = await runSetupChecks(
      deps({
        client: stubClient({
          version: async () => 'v4.3.2',
          team: async () => ({ name: 'Acme' }) as never,
          servers: async () => [{ uuid: 's1' }] as never,
          // absent, not empty — that is how Coolify says no
          serverSentinel: async () => ({}) as never,
          abilityProbe: async () => ({ granted: true, reason: 'granted', message: 'Granted.' }),
        }),
      }),
    )
    assert.equal(find(withheld.checks, 'ability-read-sensitive').status, 'warn')
  })

  it('says "unknown" rather than guessing when there is no server to ask about', async () => {
    const report = await runSetupChecks(
      deps({
        client: stubClient({
          version: async () => 'v4.3.2',
          team: async () => ({ name: 'Acme' }) as never,
          servers: async () => [],
          abilityProbe: async () => ({ granted: true, reason: 'granted', message: 'Granted.' }),
        }),
      }),
    )
    const check = find(report.checks, 'ability-read-sensitive')
    assert.equal(check.status, 'unknown')
    assert.match(check.detail, /No server to ask about/)
    // An undetermined check is not a failure.
    assert.equal(report.ok, true)
  })

  it('treats a missing password as fatal only once it is reachable from elsewhere', async () => {
    const loopback = await runSetupChecks(deps({ passwordSet: false }))
    assert.equal(find(loopback.checks, 'password').status, 'warn')
    assert.equal(loopback.ok, true)

    const exposed = await runSetupChecks(
      deps({ passwordSet: false, config: config({ host: '0.0.0.0' }) }),
    )
    assert.equal(find(exposed.checks, 'password').status, 'fail')
    assert.equal(exposed.ok, false)
  })

  it('names each optional feature that is switched off', async () => {
    const report = await runSetupChecks(
      deps({
        config: config({
          webhookSecret: null,
          probes: { ...DEFAULT_PROBE_CONFIG, enabled: false },
          metrics: { ...DEFAULT_METRICS_CONFIG, enabled: false, sshKeyPath: null },
        }),
        storeKind: 'memory',
      }),
    )

    for (const id of ['webhooks', 'probes', 'metrics', 'history']) {
      assert.equal(find(report.checks, id).status, 'warn', id)
    }
    // None of them stops the dashboard from working.
    assert.equal(report.ok, true)
  })

  it('does not let a broken team read sink the report', async () => {
    const report = await runSetupChecks(
      deps({
        client: stubClient({
          version: async () => 'v4.3.2',
          team: async () => {
            throw new CoolifyError('Server Error', { code: 'http', status: 500 })
          },
          servers: async () => [{ uuid: 's1' }] as never,
          serverSentinel: async () => ({ sentinel_token: 'st' }) as never,
          abilityProbe: async () => ({ granted: true, reason: 'granted', message: 'Granted.' }),
        }),
      }),
    )
    assert.equal(find(report.checks, 'team').status, 'warn')
    assert.equal(report.ok, true)
  })
})
