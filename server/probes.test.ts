import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LiveEvent } from '../shared/bff'
import { createEventHub } from './events'
import {
  DEFAULT_PROBE_CONFIG,
  FAILURES_BEFORE_DOWN,
  MIN_UPTIME_SAMPLES,
  createProber,
  daysUntil,
  formatUptime,
  httpTargets,
  parseTarget,
  tcpTargets,
  type HttpResult,
  type ProbeConfig,
  type TcpResult,
  type TlsResult,
} from './probes'
import { createMemoryStore } from './store'

const DAY_MS = 24 * 60 * 60_000

describe('parseTarget', () => {
  it('assumes https when the fqdn carries no scheme', () => {
    assert.deepEqual(parseTarget('app.example.com'), {
      url: 'https://app.example.com/',
      host: 'app.example.com',
      port: 443,
      https: true,
    })
  })

  it('keeps an explicit http target on port 80', () => {
    const target = parseTarget('http://internal.example.com')
    assert.equal(target?.https, false)
    assert.equal(target?.port, 80)
  })

  it('takes the first domain of the comma-separated list', () => {
    assert.equal(parseTarget('https://a.test, https://b.test')?.host, 'a.test')
  })

  it('has nothing to probe without an fqdn', () => {
    assert.equal(parseTarget(null), null)
    assert.equal(parseTarget('   '), null)
    assert.equal(parseTarget('not a url at all'), null)
  })
})

describe('httpTargets', () => {
  const applications = [
    { uuid: 'a1', name: 'api', fqdn: 'https://api.test' },
    { uuid: 'a2', name: 'worker', fqdn: null },
    { uuid: 'a3', name: 'web', fqdn: 'https://web.test' },
  ]

  it('skips applications with no public domain', () => {
    assert.deepEqual(httpTargets(applications).map(t => t.id), ['a1', 'a3'])
  })

  it('honours an allowlist by name or uuid', () => {
    assert.deepEqual(httpTargets(applications, ['web']).map(t => t.id), ['a3'])
    assert.deepEqual(httpTargets(applications, ['a1']).map(t => t.id), ['a1'])
  })
})

describe('tcpTargets', () => {
  it('needs an ip, and defaults to the ssh port', () => {
    assert.deepEqual(tcpTargets([{ uuid: 's1', name: 'node', ip: '10.0.0.1' }, { uuid: 's2', name: 'blank' }]), [
      { id: 's1', name: 'node', host: '10.0.0.1', port: 22 },
    ])
  })
})

describe('formatUptime', () => {
  it('never rounds a partial outage up to a round 100 %', () => {
    assert.equal(formatUptime(100), '100 %')
    assert.equal(formatUptime(99.98), '99.98 %')
    assert.equal(formatUptime(99.5), '99.50 %')
    assert.equal(formatUptime(97.34), '97.3 %')
    assert.equal(formatUptime(62.4), '62 %')
  })
})

describe('daysUntil', () => {
  it('floors, so "expires in 0 d" means today', () => {
    const now = Date.parse('2026-08-19T00:00:00Z')
    assert.equal(daysUntil(now + 9.5 * DAY_MS, now), 9)
    assert.equal(daysUntil(now - 2 * DAY_MS, now), -2)
  })
})

/* ------------------------------------------------------------- the loop --- */

interface Harness {
  config: ProbeConfig
  http: HttpResult[]
  tls: TlsResult
  tcp: TcpResult
}

function harness(over: Partial<Harness> = {}) {
  const store = createMemoryStore()
  const events: LiveEvent[] = []
  const hub = createEventHub()
  hub.subscribe(event => events.push(event))

  let clock = Date.parse('2026-08-19T10:00:00Z')
  const queue = [...(over.http ?? [])]
  let httpCalls = 0
  let tlsCalls = 0

  const prober = createProber({
    store,
    hub,
    config: { ...DEFAULT_PROBE_CONFIG, ...over.config },
    now: () => clock,
    targets: async () => ({
      applications: httpTargets([{ uuid: 'a1', name: 'api', fqdn: 'https://api.test' }]),
      servers: tcpTargets([{ uuid: 's1', name: 'node', ip: '10.0.0.1' }]),
    }),
    http: async () => {
      httpCalls++
      return queue.shift() ?? { ok: true, status: 200, latencyMs: 42, error: null }
    },
    tls: async () => {
      tlsCalls++
      return over.tls ?? { validTo: clock + 30 * DAY_MS, trusted: true, error: null }
    },
    tcp: async () => over.tcp ?? { ok: true, latencyMs: 7, error: null },
  })

  return {
    prober,
    store,
    events,
    advance: (ms: number) => { clock += ms },
    get httpCalls() { return httpCalls },
    get tlsCalls() { return tlsCalls },
    get now() { return clock },
  }
}

const cycles = async (h: ReturnType<typeof harness>, count: number, step = 60_000) => {
  for (let i = 0; i < count; i++) {
    await h.prober.runOnce()
    h.advance(step)
  }
}

describe('createProber', () => {
  it('measures uptime from its own samples once it has enough of them', async () => {
    const h = harness()
    await cycles(h, MIN_UPTIME_SAMPLES - 1)
    assert.equal(h.prober.snapshot().applications.get('a1')?.uptimePct, null)

    await cycles(h, 1)
    const probe = h.prober.snapshot().applications.get('a1')
    assert.equal(probe?.uptimePct, 100)
    assert.equal(probe?.samples, MIN_UPTIME_SAMPLES)
    assert.equal(probe?.avgLatencyMs, 42)
  })

  it('counts a failed probe against the percentage', async () => {
    const ok = { ok: true, status: 200, latencyMs: 10, error: null } as const
    const h = harness({ http: [ok, { ok: false, status: null, latencyMs: null, error: 'timed out' }, ok, ok, ok] })
    await cycles(h, MIN_UPTIME_SAMPLES)
    assert.equal(h.prober.snapshot().applications.get('a1')?.uptimePct, 80)
  })

  it('treats a 4xx as an answer and a 5xx as an outage', async () => {
    const h = harness({
      http: [
        { ok: true, status: 404, latencyMs: 12, error: null },
        { ok: false, status: 502, latencyMs: 9, error: 'HTTP 502' },
      ],
    })
    await cycles(h, 2)
    assert.equal(h.prober.snapshot().applications.get('a1')?.uptimePct, null) // not enough samples yet
    assert.equal(h.store.probeStats('a1', 0).up, 1)
  })

  it('announces an outage once, at the threshold, and the recovery after it', async () => {
    const down = { ok: false, status: null, latencyMs: null, error: 'timed out' } as const
    const h = harness({ http: [down, down, down, down, { ok: true, status: 200, latencyMs: 5, error: null }] })

    await cycles(h, FAILURES_BEFORE_DOWN - 1)
    assert.equal(h.events.filter(e => e.type === 'toast').length, 0)

    await cycles(h, 1)
    const first = h.events.filter(e => e.type === 'toast')
    assert.equal(first.length, 1)
    assert.match((first[0] as { message: string }).message, /stopped answering/)

    // A fourth failure is the same outage, not a second one.
    await cycles(h, 1)
    assert.equal(h.events.filter(e => e.type === 'toast').length, 1)

    await cycles(h, 1)
    const toasts = h.events.filter(e => e.type === 'toast')
    assert.equal(toasts.length, 2)
    assert.match((toasts[1] as { message: string }).message, /answering again/)
  })

  it('checks the certificate on the first cycle, then only once per interval', async () => {
    const h = harness({ config: { ...DEFAULT_PROBE_CONFIG, tlsIntervalMs: 60 * 60_000 } })
    await cycles(h, 3)
    assert.equal(h.tlsCalls, 1)

    const tls = h.prober.snapshot().applications.get('a1')?.tls
    assert.equal(tls?.daysLeft, 30)
    assert.equal(tls?.trusted, true)

    h.advance(2 * 60 * 60_000)
    await cycles(h, 1)
    assert.equal(h.tlsCalls, 2)
  })

  it('pings servers over TCP for the latency Coolify does not expose', async () => {
    const h = harness()
    await cycles(h, 1)
    assert.equal(h.prober.snapshot().servers.get('s1')?.latencyMs, 7)
    assert.equal(h.prober.snapshot().servers.get('s1')?.reachable, true)
  })

  it('keeps the last results when the fleet cannot be read', async () => {
    const store = createMemoryStore()
    let fail = false
    const prober = createProber({
      store,
      config: DEFAULT_PROBE_CONFIG,
      targets: async () => {
        if (fail) throw new Error('Coolify unreachable')
        return {
          applications: httpTargets([{ uuid: 'a1', name: 'api', fqdn: 'https://api.test' }]),
          servers: [],
        }
      },
      http: async () => ({ ok: true, status: 200, latencyMs: 11, error: null }),
    })

    await prober.runOnce()
    fail = true
    await prober.runOnce()

    assert.equal(prober.snapshot().applications.get('a1')?.latencyMs, 11)
  })

  it('forgets an application that left the fleet', async () => {
    const store = createMemoryStore()
    let apps = [
      { uuid: 'a1', name: 'api', fqdn: 'https://api.test' },
      { uuid: 'a2', name: 'web', fqdn: 'https://web.test' },
    ]
    const prober = createProber({
      store,
      config: DEFAULT_PROBE_CONFIG,
      targets: async () => ({ applications: httpTargets(apps), servers: [] }),
      http: async () => ({ ok: true, status: 200, latencyMs: 5, error: null }),
    })

    await prober.runOnce()
    assert.equal(prober.snapshot().applications.size, 2)

    apps = apps.slice(0, 1)
    await prober.runOnce()
    assert.deepEqual([...prober.snapshot().applications.keys()], ['a1'])
  })
})

describe('probe samples in the store', () => {
  it('averages latency over successful probes only', () => {
    const store = createMemoryStore()
    store.recordProbe('a1', 1, true, 100)
    store.recordProbe('a1', 2, false, null)
    store.recordProbe('a1', 3, true, 200)

    const stats = store.probeStats('a1', 0)
    assert.equal(stats.samples, 3)
    assert.equal(stats.up, 2)
    assert.equal(Math.round(stats.uptimePct), 67)
    assert.equal(stats.avgLatencyMs, 150)
  })

  it('only looks inside the window it was given', () => {
    const store = createMemoryStore()
    store.recordProbe('a1', 1_000, false, null)
    store.recordProbe('a1', 5_000, true, 10)

    assert.equal(store.probeStats('a1', 2_000).uptimePct, 100)
    assert.equal(store.probeStats('a1', 0).uptimePct, 50)
  })

  it('drops samples past the retention window', () => {
    const store = createMemoryStore()
    store.recordProbe('a1', 1_000, true, 10)
    store.recordProbe('a1', 9_000, true, 10)
    store.pruneProbes(5_000)
    assert.equal(store.probeStats('a1', 0).samples, 1)
  })
})
