import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TtlCache } from './cache'

const tick = () => new Promise(resolve => setImmediate(resolve))

describe('TtlCache', () => {
  it('serves a fresh entry without calling the loader again', async () => {
    let calls = 0
    const cache = new TtlCache(() => 0)
    const load = async () => { calls++; return 'value' }

    assert.deepEqual(await cache.fetch('k', 1000, load), { value: 'value', fresh: true })
    assert.deepEqual(await cache.fetch('k', 1000, load), { value: 'value', fresh: true })
    assert.equal(calls, 1)
  })

  it('reloads once the TTL has passed', async () => {
    let now = 0
    let calls = 0
    const cache = new TtlCache(() => now)
    const load = async () => `v${++calls}`

    await cache.fetch('k', 1000, load)
    now = 1001
    assert.equal((await cache.fetch('k', 1000, load)).value, 'v2')
    assert.equal(calls, 2)
  })

  it('single-flights concurrent callers into one upstream call', async () => {
    let calls = 0
    const cache = new TtlCache(() => 0)
    const load = async () => { calls++; await tick(); return 'value' }

    const results = await Promise.all([
      cache.fetch('k', 1000, load),
      cache.fetch('k', 1000, load),
      cache.fetch('k', 1000, load),
    ])

    assert.equal(calls, 1)
    assert.deepEqual(results.map(r => r.value), ['value', 'value', 'value'])
  })

  it('serves the stale value when a refresh fails', async () => {
    let now = 0
    const cache = new TtlCache(() => now)
    await cache.fetch('k', 1000, async () => 'first')

    now = 5000
    const result = await cache.fetch('k', 1000, async () => { throw new Error('upstream down') })

    assert.equal(result.value, 'first')
    assert.equal(result.fresh, false)
    assert.match((result.error as Error).message, /upstream down/)
  })

  it('gives every joined caller the stale value, not undefined', async () => {
    // Regression: callers joining an in-flight load must not receive the
    // placeholder entry's empty value when that load rejects.
    let now = 0
    const cache = new TtlCache(() => now)
    await cache.fetch('k', 1000, async () => 'first')

    now = 5000
    const failing = async () => { await tick(); throw new Error('boom') }
    const results = await Promise.all([
      cache.fetch('k', 1000, failing),
      cache.fetch('k', 1000, failing),
    ])

    assert.deepEqual(results.map(r => r.value), ['first', 'first'])
    assert.deepEqual(results.map(r => r.fresh), [false, false])
  })

  it('propagates the error when there is nothing stale to fall back on', async () => {
    const cache = new TtlCache(() => 0)
    await assert.rejects(
      cache.fetch('k', 1000, async () => { throw new Error('cold start') }),
      /cold start/,
    )
  })

  it('retries after a failure instead of caching it', async () => {
    let calls = 0
    const cache = new TtlCache(() => 0)
    const load = async () => {
      calls++
      if (calls === 1) throw new Error('transient')
      return 'recovered'
    }

    await assert.rejects(cache.fetch('k', 1000, load))
    assert.equal((await cache.fetch('k', 1000, load)).value, 'recovered')
  })

  it('drops entries by prefix', async () => {
    let calls = 0
    const cache = new TtlCache(() => 0)
    const load = async () => `v${++calls}`

    await cache.fetch('app:1', 1000, load)
    cache.invalidate('app:')
    await cache.fetch('app:1', 1000, load)
    assert.equal(calls, 2)
  })
})
