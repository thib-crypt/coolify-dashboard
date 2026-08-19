import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LiveEvent } from '../shared/bff'
import type * as Api from '../shared/coolify-api'
import { TtlCache } from './cache'
import type { CoolifyClient } from './coolify/client'
import { createEventHub, deploymentFinishedKey } from './events'
import { createPoller } from './poller'

/** Timer stand-in: nothing runs until a test says `fire()`. */
function fakeClock() {
  let pending: { fn: () => void; ms: number } | null = null
  let handles = 0
  return {
    delays: [] as number[],
    setTimer(fn: () => void, ms: number) {
      pending = { fn, ms }
      this.delays.push(ms)
      return ++handles
    },
    clearTimer() {
      pending = null
    },
    get armed() {
      return pending !== null
    },
    /** Runs the armed timer and settles the tick it starts. */
    async fire() {
      const next = pending
      pending = null
      assert.ok(next, 'no timer armed')
      next.fn()
      await settle()
    },
  }
}

/** Lets the poller's awaited chain finish before assertions run. */
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

const logs = (...lines: string[]) =>
  JSON.stringify(lines.map((output, order) => ({ command: null, output, type: 'stdout', timestamp: '', hidden: false, batch: 1, order })))

const queued = (uuid: string, overrides: Partial<Api.ApplicationDeploymentQueue> = {}) =>
  ({
    deployment_uuid: uuid,
    status: 'in_progress',
    application_name: 'api-core',
    ...overrides,
  }) satisfies Api.ApplicationDeploymentQueue

interface Harness {
  events: LiveEvent[]
  clock: ReturnType<typeof fakeClock>
  hub: ReturnType<typeof createEventHub>
  poller: ReturnType<typeof createPoller>
  calls: { running: number; byUuid: string[] }
}

function harness(options: {
  running: Array<Api.ApplicationDeploymentQueue[] | Error>
  byUuid?: Record<string, Api.ApplicationDeploymentQueue>
}): Harness {
  const calls = { running: 0, byUuid: [] as string[] }
  const client = {
    async runningDeployments() {
      const next = options.running[Math.min(calls.running, options.running.length - 1)]
      calls.running++
      if (next instanceof Error) throw next
      return next ?? []
    },
    async deployment(uuid: string) {
      calls.byUuid.push(uuid)
      const found = options.byUuid?.[uuid]
      if (!found) throw new Error('Deployment not found.')
      return found
    },
  } as unknown as CoolifyClient

  const events: LiveEvent[] = []
  const hub = createEventHub()
  hub.subscribe(event => events.push(event))
  const clock = fakeClock()

  const poller = createPoller({
    client,
    cache: new TtlCache(),
    hub,
    activeMs: 3000,
    idleMs: 15000,
    setTimer: clock.setTimer.bind(clock),
    clearTimer: clock.clearTimer.bind(clock),
  })

  return { events, clock, hub, poller, calls }
}

const typesOf = (events: LiveEvent[]) => events.map(event => event.type)

describe('createPoller', () => {
  it('idles at 15 s with nothing running and speeds up to 3 s once something is', async () => {
    const h = harness({ running: [[], [queued('d1')]] })

    h.poller.start()
    await settle()
    assert.equal(h.poller.state, 'idle')
    assert.deepEqual(h.clock.delays, [15000])

    await h.clock.fire()
    assert.equal(h.poller.state, 'active')
    assert.deepEqual(h.clock.delays, [15000, 3000])
  })

  it('announces a deployment that appeared, without waiting for it to finish', async () => {
    const h = harness({ running: [[queued('d1')]] })

    h.poller.start()
    await settle()

    const change = h.events.find(event => event.type === 'overview-changed')
    assert.ok(change)
    assert.match(change.type === 'overview-changed' ? change.reason : '', /started/)
  })

  it('pushes only the log lines it has not pushed yet', async () => {
    const h = harness({
      running: [
        [queued('d1', { logs: logs('cloning', 'building') })],
        [queued('d1', { logs: logs('cloning', 'building', 'pushing') })],
      ],
    })

    h.poller.start()
    await settle()
    await h.clock.fire()

    const frames = h.events.filter(event => event.type === 'deployment-log')
    assert.equal(frames.length, 2)
    assert.deepEqual(frames[0], {
      type: 'deployment-log',
      at: frames[0]?.type === 'deployment-log' ? frames[0].at : '',
      deploymentId: 'd1',
      from: 0,
      lines: ['▸ cloning', '▸ building'],
    })
    assert.equal(frames[1]?.type === 'deployment-log' && frames[1].from, 2)
    assert.deepEqual(frames[1]?.type === 'deployment-log' ? frames[1].lines : [], ['▸ pushing'])
  })

  it('says nothing when the log has not grown', async () => {
    const h = harness({
      running: [[queued('d1', { logs: logs('cloning') })], [queued('d1', { logs: logs('cloning') })]],
    })

    h.poller.start()
    await settle()
    await h.clock.fire()

    assert.equal(h.events.filter(event => event.type === 'deployment-log').length, 1)
  })

  it('asks for the terminal status once a deployment leaves /deployments', async () => {
    const h = harness({
      running: [[queued('d1', { logs: logs('building') })], []],
      byUuid: {
        d1: {
          deployment_uuid: 'd1',
          status: 'finished',
          application_name: 'api-core',
          logs: logs('building', 'done'),
        },
      },
    })

    h.poller.start()
    await settle()
    await h.clock.fire()

    assert.deepEqual(h.calls.byUuid, ['d1'])
    const finished = h.events.find(event => event.type === 'deployment-finished')
    assert.ok(finished && finished.type === 'deployment-finished')
    assert.equal(finished.state, 'success')
    assert.equal(finished.app, 'api-core')
    assert.match(finished.message, /api-core deployed/)

    // The tail of the log arrives before the outcome, so the ticker ends on it.
    assert.ok(typesOf(h.events).indexOf('deployment-log') < typesOf(h.events).indexOf('deployment-finished'))
    assert.equal(h.poller.state, 'idle')
  })

  it('reports a failed deployment as failed', async () => {
    const h = harness({
      running: [[queued('d1')], []],
      byUuid: { d1: { deployment_uuid: 'd1', status: 'failed', application_name: 'api-core' } },
    })

    h.poller.start()
    await settle()
    await h.clock.fire()

    const finished = h.events.find(event => event.type === 'deployment-finished')
    assert.equal(finished?.type === 'deployment-finished' && finished.state, 'failed')
  })

  it('still refreshes the panel when the terminal read fails', async () => {
    const h = harness({ running: [[queued('d1')], []] })

    h.poller.start()
    await settle()
    const before = h.events.length
    await h.clock.fire()

    assert.equal(h.events.slice(before).some(event => event.type === 'deployment-finished'), false)
    const change = h.events.slice(before).find(event => event.type === 'overview-changed')
    assert.match(change?.type === 'overview-changed' ? change.reason : '', /finished/)
  })

  it('does not re-announce a finish the webhook receiver already announced', async () => {
    const h = harness({
      running: [[queued('d1')], []],
      byUuid: { d1: { deployment_uuid: 'd1', status: 'finished', application_name: 'api-core' } },
    })

    h.poller.start()
    await settle()

    // Coolify's webhook is the fast path and publishes first, under the key both
    // producers build from the deployment uuid.
    h.hub.publish(
      {
        type: 'deployment-finished',
        at: '2026-08-19T10:00:00.000Z',
        deploymentId: 'd1',
        app: 'api-core',
        state: 'success',
        message: 'api-core deployed',
      },
      deploymentFinishedKey('d1'),
    )
    await h.clock.fire()

    // The poller noticed the same finish; the hub swallowed its duplicate.
    assert.deepEqual(h.calls.byUuid, ['d1'])
    assert.equal(h.events.filter(event => event.type === 'deployment-finished').length, 1)
  })

  it('backs off and warns once while upstream is failing, then says it is back', async () => {
    const boom = new Error('Cannot reach Coolify at https://coolify.test')
    const h = harness({ running: [boom, boom, []] })

    h.poller.start()
    await settle()
    assert.equal(h.clock.delays.at(-1), 30000)

    await h.clock.fire()
    assert.equal(h.clock.delays.at(-1), 60000)
    // One warning for the outage, not one per tick.
    assert.equal(h.events.filter(event => event.type === 'toast').length, 1)

    await h.clock.fire()
    const toasts = h.events.filter(event => event.type === 'toast')
    assert.equal(toasts.length, 2)
    assert.equal(toasts[1]?.type === 'toast' && toasts[1].tone, 'ok')
    assert.equal(h.clock.delays.at(-1), 15000)
  })

  it('stops polling when told to, and re-announces the log on the next start', async () => {
    const h = harness({ running: [[queued('d1', { logs: logs('cloning') })]] })

    h.poller.start()
    await settle()
    h.poller.stop()

    assert.equal(h.poller.state, 'stopped')
    assert.equal(h.clock.armed, false)

    const before = h.calls.running
    h.poller.start()
    await settle()

    assert.equal(h.calls.running, before + 1)
    // The SPA that reconnects has no log history, so index 0 is re-sent.
    const frames = h.events.filter(event => event.type === 'deployment-log')
    assert.equal(frames.length, 2)
    assert.equal(frames[1]?.type === 'deployment-log' && frames[1].from, 0)
  })

  it('runs a tick immediately when poked, without stacking a second one', async () => {
    const h = harness({ running: [[]] })

    h.poller.start()
    await settle()
    const before = h.calls.running

    h.poller.poke()
    h.poller.poke()
    await settle()

    assert.equal(h.calls.running, before + 1)
  })

  it('ignores a poke while stopped', async () => {
    const h = harness({ running: [[]] })
    h.poller.poke()
    await settle()
    assert.equal(h.calls.running, 0)
  })
})
