import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_METRICS_CONFIG,
  SECTION_MARKER,
  createMetricsCollector,
  degradedMetrics,
  isValidSentinelToken,
  metricsTargets,
  parseSentinelSeries,
  remoteCommand,
  splitSections,
  sshArgs,
  toMillis,
  zulu,
  type MetricsConfig,
  type MetricsTarget,
  type RemoteResult,
  type SentinelInfo,
  type ServerMetricsReading,
  visiblyDiffers,
} from './metrics'
import { metricsNotes } from './overview'

const NOW = Date.parse('2026-08-20T12:00:00.000Z')
const TOKEN = 'eyJpdiI6ImFiYw==.def-ghi_jkl'

const config = (over: Partial<MetricsConfig> = {}): MetricsConfig => ({
  ...DEFAULT_METRICS_CONFIG,
  enabled: true,
  sshKeyPath: '/keys/id_ed25519',
  ...over,
})

describe('remoteCommand', () => {
  it('asks Sentinel for both series in a single round trip', () => {
    const command = remoteCommand(TOKEN, '2026-08-20T11:55:00Z', 9)
    assert.match(command, /docker exec coolify-sentinel sh -c/)
    assert.match(command, /api\/cpu\/history\?from=2026-08-20T11:55:00Z/)
    assert.match(command, /api\/memory\/history\?from=2026-08-20T11:55:00Z/)
    assert.equal(command.split('curl').length - 1, 2, 'two curls, one ssh handshake')
    assert.ok(command.includes(SECTION_MARKER), 'the two JSON bodies stay separable')
    assert.match(command, new RegExp(`Authorization: Bearer ${TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('refuses a token that could break out of the remote shell', () => {
    // The token is interpolated into a string a remote shell parses. Coolify
    // validates the same character class; this is the second lock on that door.
    for (const hostile of ["a'; rm -rf /; echo '", 'a`id`', 'a$(id)', 'a b', '']) {
      assert.equal(isValidSentinelToken(hostile), false, hostile)
      assert.throws(() => remoteCommand(hostile, '2026-08-20T11:55:00Z', 9), /metacharacters/)
    }
  })

  it('accepts the base64-ish shape Laravel actually produces', () => {
    assert.equal(isValidSentinelToken(TOKEN), true)
    assert.equal(isValidSentinelToken('eyJhbGciOi/J9+abc=='), true)
  })
})

describe('zulu', () => {
  it('drops the milliseconds, like the format HasMetrics sends', () => {
    assert.equal(zulu(NOW), '2026-08-20T12:00:00Z')
  })
})

describe('sshArgs', () => {
  const target = { host: '10.0.0.1', user: 'root', port: 2222 }

  it('passes the command as one argv element, never through a local shell', () => {
    const args = sshArgs(target, 'docker exec x sh -c \'echo hi\'', config())
    assert.equal(args.at(-1), 'docker exec x sh -c \'echo hi\'')
    assert.equal(args.at(-2), 'root@10.0.0.1')
    assert.deepEqual(args.slice(-4, -2), ['-p', '2222'])
  })

  it('never prompts: no password, no TTY, no interactive host key', () => {
    const args = sshArgs(target, 'true', config()).join(' ')
    assert.match(args, /BatchMode=yes/)
    assert.match(args, /PasswordAuthentication=no/)
    assert.match(args, /StrictHostKeyChecking=accept-new/)
    assert.match(args, /-i \/keys\/id_ed25519/)
    assert.match(args, /IdentitiesOnly=yes/)
    assert.doesNotMatch(args, /UserKnownHostsFile/, 'accept-new needs a real known_hosts to pin into')
  })

  it('only throws away known_hosts when the operator asked for it explicitly', () => {
    const args = sshArgs(target, 'true', config({ strictHostKey: 'no' })).join(' ')
    assert.match(args, /StrictHostKeyChecking=no/)
    assert.match(args, /UserKnownHostsFile=\/dev\/null/)
  })
})

describe('parseSentinelSeries', () => {
  it('reads the field each metric actually uses', () => {
    const cpu = parseSentinelSeries('[{"time":1755691200,"percent":41.5}]', 'percent')
    assert.deepEqual(cpu, [{ at: 1755691200000, value: 41.5 }])
    // A *server*'s memory reports usedPercent; a container's reports raw bytes,
    // which is why the field is not guessed from the payload.
    const mem = parseSentinelSeries('[{"time":1755691200,"usedPercent":68}]', 'usedPercent')
    assert.deepEqual(mem, [{ at: 1755691200000, value: 68 }])
  })

  it('sorts oldest first so the tail is always the newest sample', () => {
    const points = parseSentinelSeries('[{"time":300,"percent":3},{"time":100,"percent":1}]', 'percent')
    assert.deepEqual(points.map(p => p.value), [1, 3])
  })

  it('surfaces Sentinel\'s own error instead of a parse failure', () => {
    assert.throws(() => parseSentinelSeries('{"error":"Unauthorized"}', 'percent'), /Unauthorized/)
  })

  it('reports a non-JSON body — usually docker or ssh talking, not Sentinel', () => {
    assert.throws(
      () => parseSentinelSeries('Error: No such container: coolify-sentinel', 'percent'),
      /non-JSON body: Error: No such container/,
    )
    assert.throws(() => parseSentinelSeries('   ', 'percent'), /empty body/)
  })

  it('skips rows it cannot read rather than turning them into zeroes', () => {
    const points = parseSentinelSeries('[{"time":100,"percent":1},{"time":"x","percent":2},null,{"time":200}]', 'percent')
    assert.deepEqual(points, [{ at: 100000, value: 1 }])
  })

  it('clamps into the range a percentage gauge can render', () => {
    const points = parseSentinelSeries('[{"time":100,"percent":140},{"time":200,"percent":-3}]', 'percent')
    assert.deepEqual(points.map(p => p.value), [100, 0])
  })
})

describe('toMillis', () => {
  it('promotes epoch seconds and leaves milliseconds alone', () => {
    assert.equal(toMillis(1755691200), 1755691200000)
    assert.equal(toMillis(1755691200000), 1755691200000)
  })
})

describe('splitSections', () => {
  it('splits the two bodies on the marker', () => {
    assert.deepEqual(splitSections(`[1]\n${SECTION_MARKER}\n[2]`)?.map(s => s.trim()), ['[1]', '[2]'])
  })

  it('returns null when the second curl never ran', () => {
    assert.equal(splitSections('curl: (7) Failed to connect'), null)
  })
})

describe('metricsTargets', () => {
  const servers = [
    { uuid: 's1', name: 'fsn1', ip: '10.0.0.1', user: 'root', port: 22, is_reachable: true, settings: { is_metrics_enabled: true } },
    { uuid: 's2', name: 'hel1', ip: '10.0.0.2', is_reachable: true, settings: { is_metrics_enabled: false } },
    { uuid: 's3', name: 'no-address', is_reachable: true, settings: { is_metrics_enabled: true } },
  ]

  it('skips a server with no address and defaults the login to root', () => {
    const targets = metricsTargets(servers, config())
    assert.deepEqual(targets.map(t => t.id), ['s1', 's2'])
    assert.equal(targets[1]?.user, 'root')
    assert.equal(targets[1]?.port, 22)
  })

  it('keeps a server whose metrics are off — it still owes the panel a reason', () => {
    assert.equal(metricsTargets(servers, config()).find(t => t.id === 's2')?.metricsEnabled, false)
  })

  it('honours METRICS_SERVERS by name or uuid', () => {
    assert.deepEqual(metricsTargets(servers, config({ only: ['hel1'] })).map(t => t.id), ['s2'])
    assert.deepEqual(metricsTargets(servers, config({ only: ['s1'] })).map(t => t.id), ['s1'])
  })

  it('lets the operator override the login for every server at once', () => {
    assert.equal(metricsTargets(servers, config({ sshUser: 'deploy' }))[0]?.user, 'deploy')
  })
})

describe('degradedMetrics', () => {
  it('blames this dashboard, not the server, when no collector is configured', () => {
    const { source, note } = degradedMetrics({ collector: false, metricsEnabled: true, reachable: true })
    assert.equal(source, 'off')
    assert.match(note, /METRICS_SSH_KEY/)
  })

  it('distinguishes Sentinel being off from Sentinel being unreachable', () => {
    assert.equal(degradedMetrics({ collector: true, metricsEnabled: false, reachable: true }).source, 'sentinel-off')
    assert.equal(degradedMetrics({ collector: true, metricsEnabled: true, reachable: false }).source, 'error')
  })
})

/* ------------------------------------------------------------ collector --- */

const body = (cpu: number, mem: number, at = NOW) =>
  `${JSON.stringify([{ time: Math.floor(at / 1000), percent: cpu }])}\n${SECTION_MARKER}\n` +
  `${JSON.stringify([{ time: Math.floor(at / 1000), usedPercent: mem }])}`

const ok = (stdout: string): RemoteResult => ({ code: 0, stdout, stderr: '' })

const target = (over: Partial<MetricsTarget> = {}): MetricsTarget => ({
  id: 's1',
  name: 'fsn1',
  host: '10.0.0.1',
  user: 'root',
  port: 22,
  metricsEnabled: true,
  reachable: true,
  ...over,
})

const sentinel = (over: Partial<SentinelInfo> = {}): SentinelInfo => ({
  metricsEnabled: true,
  token: TOKEN,
  updatedAt: NOW - 30_000,
  ...over,
})

interface Harness {
  targets?: MetricsTarget[] | (() => Promise<MetricsTarget[]>)
  info?: SentinelInfo | (() => Promise<SentinelInfo>)
  result?: RemoteResult | (() => RemoteResult)
  onTokenRejected?: (uuid: string) => void
  hub?: { publish: (event: unknown) => boolean }
}

function collector(harness: Harness = {}) {
  const calls: string[][] = []
  const fleet = harness.targets ?? [target()]
  const info = harness.info ?? sentinel()

  const instance = createMetricsCollector({
    config: config(),
    now: () => NOW,
    targets: typeof fleet === 'function' ? fleet : async () => fleet,
    sentinel: typeof info === 'function' ? info : async () => info,
    ...(harness.onTokenRejected ? { onTokenRejected: harness.onTokenRejected } : {}),
    ...(harness.hub ? { hub: harness.hub as never } : {}),
    run: async args => {
      calls.push(args)
      const result = harness.result ?? ok(body(41.5, 68))
      return typeof result === 'function' ? result() : result
    },
  })
  return { instance, calls }
}

describe('createMetricsCollector', () => {
  it('reads real percentages off the Sentinel agent', async () => {
    const { instance, calls } = collector()
    await instance.runOnce()

    const reading = instance.snapshot().servers.get('s1')
    assert.equal(reading?.source, 'sentinel')
    assert.equal(reading?.cpu, 41.5)
    assert.equal(reading?.mem, 68)
    assert.match(reading?.note ?? '', /Measured by Sentinel on fsn1/)
    assert.equal(calls.length, 1, 'one SSH connection per server per cycle')
  })

  it('will not pass off an old sample as a current one', async () => {
    const { instance } = collector({ result: ok(body(41.5, 68, NOW - 10 * 60_000)) })
    await instance.runOnce()

    const reading = instance.snapshot().servers.get('s1')
    assert.equal(reading?.source, 'stale')
    assert.equal(reading?.cpu, null)
    assert.equal(reading?.mem, null)
    assert.match(reading?.note ?? '', /10 min old/)
    // The heartbeat separates "the agent is alive but idle" from "it is gone":
    // here it pushed 30 s ago, so the silence is in its metrics, not its process.
    assert.match(reading?.note ?? '', /heard from the agent less than a minute ago/)
  })

  it('says how long ago Coolify last heard from a silent agent', async () => {
    const { instance } = collector({
      result: ok(body(41.5, 68, NOW - 10 * 60_000)),
      info: sentinel({ updatedAt: NOW - 3 * 60 * 60_000 }),
    })
    await instance.runOnce()
    assert.match(instance.snapshot().servers.get('s1')?.note ?? '', /last heard from the agent 3 h ago/)
  })

  it('spends nothing on a server whose metrics are switched off', async () => {
    let asked = 0
    const { instance, calls } = collector({
      targets: [target({ metricsEnabled: false })],
      info: async () => {
        asked++
        return sentinel()
      },
    })
    await instance.runOnce()

    assert.equal(asked, 0, 'no upstream read')
    assert.equal(calls.length, 0, 'no SSH connection')
    assert.equal(instance.snapshot().servers.get('s1')?.source, 'sentinel-off')
  })

  it('names the missing ability when Coolify withholds the token', async () => {
    const { instance, calls } = collector({ info: sentinel({ token: null }) })
    await instance.runOnce()

    assert.equal(calls.length, 0)
    assert.match(instance.snapshot().servers.get('s1')?.note ?? '', /read:sensitive/)
  })

  it('reports what ssh said, not an exit code — every line of it', async () => {
    const { instance } = collector({
      result: {
        code: 255,
        stdout: '',
        // The actionable half is the warning, the conclusive half is the denial:
        // dropping either one leaves the operator guessing.
        stderr: 'Warning: Identity file /keys/id_ed25519 not accessible.\nroot@10.0.0.1: Permission denied (publickey).',
      },
    })
    await instance.runOnce()

    const reading = instance.snapshot().servers.get('s1')
    assert.equal(reading?.source, 'error')
    assert.match(reading?.note ?? '', /Identity file .* not accessible/)
    assert.match(reading?.note ?? '', /Permission denied \(publickey\)/)
  })

  it('drops the cached token when Sentinel rejects it', async () => {
    const rejected: string[] = []
    const { instance } = collector({
      result: ok(`{"error":"Unauthorized"}\n${SECTION_MARKER}\n[]`),
      onTokenRejected: uuid => rejected.push(uuid),
    })
    await instance.runOnce()

    assert.deepEqual(rejected, ['s1'], 'a regenerated token must not fail forever')
    assert.match(instance.snapshot().servers.get('s1')?.note ?? '', /regenerated/)
  })

  it('says so when Sentinel answers but has recorded nothing', async () => {
    const { instance } = collector({ result: ok(`[]\n${SECTION_MARKER}\n[]`) })
    await instance.runOnce()

    const reading = instance.snapshot().servers.get('s1')
    assert.equal(reading?.source, 'stale')
    assert.match(reading?.note ?? '', /no sample in the last 5 min/)
  })

  it('keeps the last readings when the fleet cannot be read', async () => {
    let fail = false
    const { instance } = collector({
      targets: async () => {
        if (fail) throw new Error('Coolify unreachable')
        return [target()]
      },
    })
    await instance.runOnce()
    fail = true
    await instance.runOnce()

    assert.equal(instance.snapshot().servers.get('s1')?.cpu, 41.5)
  })

  it('forgets a server that left the fleet', async () => {
    let fleet = [target(), target({ id: 's2', name: 'hel1', host: '10.0.0.2' })]
    const { instance } = collector({ targets: async () => fleet })
    await instance.runOnce()
    assert.equal(instance.snapshot().servers.size, 2)

    fleet = [target()]
    await instance.runOnce()
    assert.deepEqual([...instance.snapshot().servers.keys()], ['s1'])
  })

  it('stays inert until it is enabled — the default install has no key', () => {
    let scheduled = 0
    const instance = createMetricsCollector({
      config: config({ enabled: false }),
      targets: async () => [target()],
      sentinel: async () => sentinel(),
      run: async () => ok(body(1, 2)),
      setTimer: () => scheduled++,
    })
    instance.start()
    assert.equal(scheduled, 0)
    assert.equal(instance.snapshot().enabled, false)
  })
})

/* ---------------------------------------------------------------- notes --- */

describe('metricsNotes', () => {
  const snapshot = (over: Partial<ReturnType<typeof empty>> = {}) => ({ ...empty(), ...over })
  const empty = () => ({ enabled: true, lastRunAt: NOW, servers: new Map<string, ReadingLike>() })

  interface ReadingLike {
    id: string
    name: string
    cpu: number | null
    mem: number | null
    source: 'sentinel' | 'off' | 'sentinel-off' | 'stale' | 'error'
    note: string
    at: number | null
    checkedAt: number
  }

  const reading = (source: ReadingLike['source'], note = 'because'): ReadingLike => ({
    id: 's1',
    name: 'fsn1',
    cpu: null,
    mem: null,
    source,
    note,
    at: null,
    checkedAt: NOW,
  })

  it('explains the default install once, at the top level', () => {
    const notes = metricsNotes({ enabled: false, lastRunAt: null, servers: new Map() }, 2)
    assert.equal(notes.length, 1)
    assert.match(notes[0]?.reason ?? '', /no REST endpoint for CPU or RAM/)
    assert.match(notes[0]?.reason ?? '', /METRICS_SSH_KEY/)
  })

  it('has nothing to add once every server reports', () => {
    assert.deepEqual(metricsNotes(snapshot({ servers: new Map([['s1', reading('sentinel')]]) }), 1), [])
  })

  it('repeats the single failing server\'s own sentence', () => {
    const notes = metricsNotes(snapshot({ servers: new Map([['s1', reading('error', 'ssh said no')]]) }), 1)
    assert.equal(notes[0]?.reason, 'ssh said no')
  })

  it('counts them instead when several are silent', () => {
    const servers = new Map([
      ['s1', reading('error')],
      ['s2', { ...reading('stale'), id: 's2' }],
      ['s3', { ...reading('sentinel'), id: 's3' }],
    ])
    assert.match(metricsNotes(snapshot({ servers }), 3)[0]?.reason ?? '', /2 of 3 servers are not reporting/)
  })

  it('says the first cycle has not landed rather than blaming a server', () => {
    assert.match(metricsNotes(snapshot(), 2)[0]?.reason ?? '', /first cycle/)
  })
})

describe('visiblyDiffers', () => {
  const reading = (over: Partial<ServerMetricsReading> = {}): ServerMetricsReading => ({
    id: 's1',
    name: 'fsn1',
    cpu: 41.5,
    mem: 68,
    source: 'sentinel',
    note: 'Measured by Sentinel on fsn1, 1 s ago.',
    at: NOW,
    checkedAt: NOW,
    ...over,
  })

  it('ignores movement the rounded gauge would never show', () => {
    // The bar renders whole percents: 41.5 → 41.6 is noise, not news.
    assert.equal(visiblyDiffers(reading(), reading({ cpu: 41.6 })), false)
  })

  it('notices a change a reader would see', () => {
    assert.equal(visiblyDiffers(reading(), reading({ cpu: 55 })), true)
    assert.equal(visiblyDiffers(reading(), reading({ cpu: null, source: 'error', note: 'ssh died' })), true)
    assert.equal(visiblyDiffers(undefined, reading()), true)
  })
})

describe('the live nudge', () => {
  it('wakes open tabs only when a gauge actually moved', async () => {
    const published: string[] = []
    let cpu = 41.5
    const { instance } = collector({
      hub: { publish: (event: unknown) => { published.push((event as { reason: string }).reason); return true } },
      result: () => ok(body(cpu, 68)),
    })

    await instance.runOnce()
    assert.deepEqual(published, ['metrics'], 'the first reading is new by definition')

    await instance.runOnce()
    assert.deepEqual(published, ['metrics'], 'an unchanged fleet costs every tab nothing')

    cpu = 62
    await instance.runOnce()
    assert.deepEqual(published, ['metrics', 'metrics'])
  })
})
