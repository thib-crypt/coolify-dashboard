import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LiveEvent } from '../shared/bff'
import { deploymentFinishedKey } from './events'
import { interpretWebhook, secretMatches } from './hooks'

const AT = '2026-08-19T10:00:00.000Z'

const kinds = (events: Array<{ event: LiveEvent }>) => events.map(entry => entry.event.type)
const toastOf = (effect: ReturnType<typeof interpretWebhook>) =>
  effect.events.map(entry => entry.event).find(event => event.type === 'toast')

describe('interpretWebhook', () => {
  it('always offers a refresh, whatever the event', () => {
    for (const event of ['deployment_success', 'task_success', 'docker_cleanup_success', 'nonsense']) {
      const effect = interpretWebhook({ event }, AT)
      assert.equal(effect.refresh.type, 'overview-changed', `no refresh for ${event}`)
      assert.match(effect.refresh.type === 'overview-changed' ? effect.refresh.reason : '', new RegExp(event))
    }
  })

  it('keeps the refresh out of the dedupable announcements', () => {
    // The route drops it on a retry; leaving it in `events` would make every
    // fifth delivery look new and cost one /app/overview per open tab.
    const effect = interpretWebhook({ event: 'server_unreachable', server_name: 'edge-1' }, AT)
    assert.ok(!kinds(effect.events).includes('overview-changed'))
    assert.ok(effect.events.every(entry => typeof entry.key === 'string'))
  })

  it('announces nothing dedupable for a silent success', () => {
    // `events` empty is what tells the route this payload is new by definition.
    assert.deepEqual(interpretWebhook({ event: 'backup_success', database_name: 'pg' }, AT).events, [])
    assert.deepEqual(interpretWebhook({ event: 'task_success', task_name: 'prune' }, AT).events, [])
  })

  it('turns a successful deployment into the same keyed event the poller would emit', () => {
    const effect = interpretWebhook(
      {
        event: 'deployment_success',
        application_name: 'api-core',
        application_uuid: 'a1',
        deployment_uuid: 'd1',
      },
      AT,
    )

    const finished = effect.events.find(entry => entry.event.type === 'deployment-finished')
    assert.ok(finished)
    assert.equal(finished.key, deploymentFinishedKey('d1'))
    assert.equal(finished.event.type === 'deployment-finished' && finished.event.state, 'success')
    assert.equal(finished.event.type === 'deployment-finished' && finished.event.app, 'api-core')
    assert.deepEqual(effect.invalidate, ['deployments'])
    assert.equal(effect.pokePoller, true)
  })

  it('marks a failed deployment as failed', () => {
    const effect = interpretWebhook(
      { event: 'deployment_failed', application_name: 'api-core', deployment_uuid: 'd2' },
      AT,
    )
    const finished = effect.events.map(e => e.event).find(e => e.type === 'deployment-finished')
    assert.equal(finished?.type === 'deployment-finished' && finished.state, 'failed')
  })

  it('falls back to a toast when the payload carries no deployment uuid', () => {
    const effect = interpretWebhook({ event: 'deployment_failed', application_name: 'api-core' }, AT)
    assert.ok(!kinds(effect.events).includes('deployment-finished'))
    assert.equal(toastOf(effect)?.type === 'toast' && toastOf(effect)?.tone, 'err')
  })

  it('names the server and drops its cache when one goes unreachable', () => {
    const effect = interpretWebhook({ event: 'server_unreachable', server_name: 'edge-1' }, AT)
    assert.deepEqual(effect.invalidate, ['servers'])
    const toast = toastOf(effect)
    assert.equal(toast?.type === 'toast' && toast.tone, 'err')
    assert.match(toast?.type === 'toast' ? toast.message : '', /edge-1/)
  })

  it('quotes the disk figure when Coolify sends one', () => {
    const effect = interpretWebhook(
      { event: 'high_disk_usage', server_name: 'edge-1', disk_usage: 91, threshold: 80 },
      AT,
    )
    const toast = toastOf(effect)
    assert.match(toast?.type === 'toast' ? toast.message : '', /91 %/)
  })

  it('keeps the disk figure as a signal, since no REST endpoint carries it', () => {
    const effect = interpretWebhook(
      { event: 'high_disk_usage', server_name: 'edge-1', disk_usage: 91, threshold: 80 },
      AT,
    )
    assert.deepEqual(effect.signals, [
      { kind: 'disk_usage', subject: 'edge-1', value: 91, at: Date.parse(AT) },
    ])
  })

  it('records no signal when the payload carries no figure', () => {
    const effect = interpretWebhook({ event: 'high_disk_usage', server_name: 'edge-1' }, AT)
    assert.deepEqual(effect.signals, [])
  })

  it('stays silent on a successful backup but still refreshes', () => {
    const effect = interpretWebhook({ event: 'backup_success', database_name: 'postgres' }, AT)
    assert.equal(toastOf(effect), undefined)
    assert.deepEqual(effect.invalidate, ['databases', 'backups'])
  })

  it('speaks up on a failed backup', () => {
    const effect = interpretWebhook({ event: 'backup_failed', database_name: 'postgres' }, AT)
    const toast = toastOf(effect)
    assert.equal(toast?.type === 'toast' && toast.tone, 'err')
    assert.match(toast?.type === 'toast' ? toast.message : '', /postgres/)
  })

  it('reads the resource name from whichever field the event uses', () => {
    const task = interpretWebhook({ event: 'task_failed', task_name: 'nightly-prune' }, AT)
    assert.match(
      (() => {
        const toast = toastOf(task)
        return toast?.type === 'toast' ? toast.message : ''
      })(),
      /nightly-prune/,
    )

    const container = interpretWebhook({ event: 'container_stopped', container_name: 'worker-1' }, AT)
    assert.match(
      (() => {
        const toast = toastOf(container)
        return toast?.type === 'toast' ? toast.message : ''
      })(),
      /worker-1/,
    )
  })

  it('survives a payload with nothing but an event name', () => {
    const effect = interpretWebhook({ event: 'server_unreachable' }, AT)
    const toast = toastOf(effect)
    assert.match(toast?.type === 'toast' ? toast.message : '', /A server/)
  })

  it('keys repeatable events so Coolify’s five retries collapse into one', () => {
    const first = interpretWebhook({ event: 'server_unreachable', server_name: 'edge-1' }, AT)
    const retry = interpretWebhook({ event: 'server_unreachable', server_name: 'edge-1' }, '2026-08-19T10:00:30.000Z')
    const firstKey = first.events.find(e => e.event.type === 'toast')?.key
    const retryKey = retry.events.find(e => e.event.type === 'toast')?.key
    assert.ok(firstKey)
    assert.equal(firstKey, retryKey)
  })
})

describe('secretMatches', () => {
  it('accepts the exact secret', () => {
    assert.equal(secretMatches('s3cret', 's3cret'), true)
  })

  it('rejects a wrong secret, a missing one, and a prefix of the right one', () => {
    assert.equal(secretMatches('s3cret', 'wrong'), false)
    assert.equal(secretMatches('s3cret', undefined), false)
    assert.equal(secretMatches('s3cret', ''), false)
    // A length mismatch must not throw the way a raw timingSafeEqual would.
    assert.equal(secretMatches('s3cret', 's3cre'), false)
    assert.equal(secretMatches('s3cret', 's3crets'), false)
  })

  it('refuses to match when no secret is configured', () => {
    assert.equal(secretMatches('', ''), false)
    assert.equal(secretMatches('', 'anything'), false)
  })
})
