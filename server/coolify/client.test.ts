import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { ConfiguredBffConfig } from '../config'
import { CoolifyError, classify, createCoolifyClient } from './client'

const config: ConfiguredBffConfig = {
  coolifyUrl: 'https://coolify.test',
  coolifyToken: 'token',
  port: 0,
  dataDir: '.',
  requestTimeoutMs: 1000,
  deploymentHistoryTake: 5,
  webhookSecret: null,
  pollActiveMs: 3000,
  pollIdleMs: 15000,
}

interface Call {
  url: string
  method: string
  contentType: string | null
  body: string | null
}

const realFetch = globalThis.fetch

/** Answers each request from `replies`, in order, recording what was sent. */
function stubFetch(replies: Array<{ status: number; body: unknown }>): Call[] {
  const calls: Call[] = []
  let index = 0
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      contentType: headers.get('content-type'),
      body: typeof init.body === 'string' ? init.body : null,
    })
    const reply = replies[index++] ?? { status: 500, body: { message: 'no reply queued' } }
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as typeof fetch
  return calls
}

afterEach(() => { globalThis.fetch = realFetch })

describe('classify', () => {
  it('separates a full deployment queue from the rate limiter — both are 429', () => {
    assert.equal(classify(429, 'Deployment queue is full. Please wait for existing deployments to complete.'), 'queue_full')
    assert.equal(classify(429, 'Too Many Attempts.'), 'rate_limited')
  })
})

describe('writes', () => {
  it('sends JSON with the content type Coolify insists on', async () => {
    const calls = stubFetch([{ status: 200, body: { deployments: [] } }])
    await createCoolifyClient(config).deploy('app-1', { force: true })

    assert.deepEqual(calls, [{
      url: 'https://coolify.test/api/v1/deploy',
      method: 'POST',
      contentType: 'application/json',
      body: '{"uuid":"app-1","force":true}',
    }])
  })

  it('cancels without a body — that route takes none', async () => {
    const calls = stubFetch([{ status: 200, body: { message: 'Deployment cancelled successfully.' } }])
    await createCoolifyClient(config).cancelDeployment('dep 1')

    assert.equal(calls[0]?.url, 'https://coolify.test/api/v1/deployments/dep%201/cancel')
    assert.equal(calls[0]?.body, null)
    assert.equal(calls[0]?.contentType, null)
  })

  it('surfaces a refused cancellation as a bad_request', async () => {
    stubFetch([{ status: 400, body: { message: 'Deployment cannot be cancelled. Current status: finished' } }])
    await assert.rejects(
      createCoolifyClient(config).cancelDeployment('dep-1'),
      (error: unknown) => error instanceof CoolifyError && error.code === 'bad_request',
    )
  })
})

describe('applicationAction', () => {
  it('uses POST, as every supported instance requires', async () => {
    const calls = stubFetch([{ status: 200, body: { message: 'Restart request queued.' } }])
    await createCoolifyClient(config).applicationAction('app-1', 'restart')

    assert.equal(calls[0]?.method, 'POST')
    assert.equal(calls[0]?.url, 'https://coolify.test/api/v1/applications/app-1/restart')
  })

  it('falls back to GET on an older instance, then remembers it', async () => {
    const calls = stubFetch([
      { status: 405, body: { message: 'The POST method is not supported for this route.' } },
      { status: 200, body: { message: 'Restart request queued.' } },
      { status: 200, body: { message: 'Stopping request queued.' } },
    ])
    const client = createCoolifyClient(config)

    await client.applicationAction('app-1', 'restart')
    await client.applicationAction('app-1', 'stop')

    assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'GET'])
  })

  it('reports the POST rejection when neither verb works', async () => {
    stubFetch([
      { status: 405, body: { message: 'This endpoint has changed to a POST request.' } },
      { status: 405, body: { message: 'This endpoint has changed to a POST request.' } },
    ])
    await assert.rejects(
      createCoolifyClient(config).applicationAction('app-1', 'stop'),
      (error: unknown) => error instanceof CoolifyError && error.status === 405,
    )
  })

  it('keeps POST for later calls once one has worked', async () => {
    const calls = stubFetch([
      { status: 200, body: { message: 'Restart request queued.' } },
      { status: 405, body: { message: 'nope' } },
    ])
    const client = createCoolifyClient(config)

    await client.applicationAction('app-1', 'restart')
    await assert.rejects(client.applicationAction('app-1', 'restart'))

    assert.deepEqual(calls.map(call => call.method), ['POST', 'POST'])
  })
})
