import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LiveEvent } from '../shared/bff'
import { createEventHub, deploymentFinishedKey } from './events'

const changed = (reason = 'test'): LiveEvent => ({
  type: 'overview-changed',
  at: '2026-08-19T10:00:00.000Z',
  reason,
})

describe('createEventHub', () => {
  it('broadcasts to every subscriber', () => {
    const hub = createEventHub()
    const a: LiveEvent[] = []
    const b: LiveEvent[] = []
    hub.subscribe(event => a.push(event))
    hub.subscribe(event => b.push(event))

    hub.publish(changed())

    assert.equal(a.length, 1)
    assert.equal(b.length, 1)
    assert.equal(hub.subscribers, 2)
  })

  it('stops delivering after unsubscribe, and unsubscribing twice is harmless', () => {
    const hub = createEventHub()
    const seen: LiveEvent[] = []
    const off = hub.subscribe(event => seen.push(event))

    off()
    off()
    hub.publish(changed())

    assert.deepEqual(seen, [])
    assert.equal(hub.subscribers, 0)
  })

  it('reports only the 0 → 1 and 1 → 0 transitions', () => {
    const transitions: boolean[] = []
    const hub = createEventHub({ onActivity: has => transitions.push(has) })

    const first = hub.subscribe(() => {})
    const second = hub.subscribe(() => {})
    first()
    second()

    assert.deepEqual(transitions, [true, false])
  })

  it('drops a repeat of the same key inside the window', () => {
    let now = 0
    const hub = createEventHub({ now: () => now, dedupeWindowMs: 1000 })
    const seen: LiveEvent[] = []
    hub.subscribe(event => seen.push(event))

    assert.equal(hub.publish(changed('first'), 'k'), true)
    now = 500
    assert.equal(hub.publish(changed('retry'), 'k'), false)
    now = 1500
    assert.equal(hub.publish(changed('later'), 'k'), true)

    assert.deepEqual(seen.map(e => (e.type === 'overview-changed' ? e.reason : '')), ['first', 'later'])
  })

  it('never deduplicates an unkeyed event', () => {
    const hub = createEventHub()
    const seen: LiveEvent[] = []
    hub.subscribe(event => seen.push(event))

    hub.publish(changed())
    hub.publish(changed())

    assert.equal(seen.length, 2)
  })

  it('keeps delivering to the other subscribers when one throws', () => {
    const hub = createEventHub()
    const seen: LiveEvent[] = []
    hub.subscribe(() => {
      throw new Error('dead connection')
    })
    hub.subscribe(event => seen.push(event))

    assert.equal(hub.publish(changed()), true)
    assert.equal(seen.length, 1)
  })

  it('gives both producers the same key for one deployment finishing', () => {
    // The poller and the webhook receiver must agree, or a finish toasts twice.
    assert.equal(deploymentFinishedKey('d1'), deploymentFinishedKey('d1'))
    assert.notEqual(deploymentFinishedKey('d1'), deploymentFinishedKey('d2'))
  })
})
