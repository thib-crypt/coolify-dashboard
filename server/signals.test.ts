import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SIGNAL_TTL_MS, createSignalStore } from './signals'

const NOW = Date.parse('2026-08-19T10:00:00Z')

describe('createSignalStore', () => {
  it('keeps the reading a webhook carried', () => {
    const store = createSignalStore()
    store.record({ kind: 'disk_usage', subject: 'node-1', value: 87, at: NOW })
    assert.equal(store.latest('disk_usage', 'node-1', NOW)?.value, 87)
  })

  it('matches the subject regardless of case, as webhook names are free-form', () => {
    const store = createSignalStore()
    store.record({ kind: 'disk_usage', subject: 'Node-1', value: 91, at: NOW })
    assert.equal(store.latest('disk_usage', 'node-1', NOW)?.value, 91)
  })

  it('forgets a reading rather than showing a stale percentage', () => {
    const store = createSignalStore()
    store.record({ kind: 'disk_usage', subject: 'node-1', value: 87, at: NOW })

    const later = NOW + SIGNAL_TTL_MS.disk_usage
    assert.equal(store.latest('disk_usage', 'node-1', later), null)
    assert.equal(store.size, 0)
  })

  it('ignores a retry that arrives after a newer reading', () => {
    const store = createSignalStore()
    store.record({ kind: 'disk_usage', subject: 'node-1', value: 92, at: NOW })
    store.record({ kind: 'disk_usage', subject: 'node-1', value: 87, at: NOW - 60_000 })
    assert.equal(store.latest('disk_usage', 'node-1', NOW)?.value, 92)
  })

  it('has nothing to say about a subject it never heard of', () => {
    assert.equal(createSignalStore().latest('disk_usage', 'ghost', NOW), null)
  })
})
