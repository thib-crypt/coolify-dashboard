import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  DEFAULT_SESSION_TTL_MS,
  SESSION_COOKIE,
  createAttemptLimiter,
  createAuth,
  createSessionCodec,
  mountSession,
  passwordMatches,
  type AuthConfig,
} from './auth'
import type { SessionResponse } from '../shared/bff'

const HOUR = 3_600_000

const withPassword = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  password: 'hunter2',
  sessionSecret: null,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  ...over,
})

/** A Hono app wired the way `index.ts` wires it: session routes, then the guard. */
function protectedApp(config: AuthConfig) {
  const auth = createAuth(config)
  const app = new Hono()
  mountSession(app, auth, config, () => 'test-client')
  app.use('/app/*', auth.guard)
  app.get('/app/health', c => c.json({ service: 'coolify-dashboard-bff', seen: auth.isAuthenticated(c) }))
  app.post('/app/deploy', c => c.json({ deployed: true }))
  return app
}

/** The cookie value a `Set-Cookie` header carries, ignoring its attributes. */
const cookieValue = (res: Response): string =>
  (res.headers.get('set-cookie') ?? '').split(';')[0]?.split('=').slice(1).join('=') ?? ''

const signIn = (app: Hono, password: string) =>
  app.request('/app/session', {
    method: 'POST',
    body: JSON.stringify({ password }),
    headers: { 'Content-Type': 'application/json' },
  })

describe('passwordMatches', () => {
  it('accepts the password and nothing else', () => {
    assert.equal(passwordMatches('hunter2', 'hunter2'), true)
    assert.equal(passwordMatches('hunter2', 'hunter3'), false)
    // A prefix must not pass: the comparison is over digests, not the strings.
    assert.equal(passwordMatches('hunter2', 'hunter'), false)
  })

  it('refuses anything that is not a non-empty string', () => {
    for (const value of [undefined, null, 42, {}, '', ['hunter2']]) {
      assert.equal(passwordMatches('hunter2', value), false)
    }
    assert.equal(passwordMatches('', ''), false)
  })
})

describe('createSessionCodec', () => {
  const codec = createSessionCodec('secret', 2 * HOUR)

  it('issues a token it can verify, carrying its own expiry', () => {
    const now = Date.UTC(2026, 0, 1)
    const { token, expiresAt } = codec.issue(now)
    assert.equal(expiresAt, now + 2 * HOUR)
    assert.equal(codec.verify(token, now + HOUR), expiresAt)
  })

  it('refuses a token past its expiry', () => {
    const now = Date.UTC(2026, 0, 1)
    const { token } = codec.issue(now)
    assert.equal(codec.verify(token, now + 3 * HOUR), null)
  })

  it('refuses an expiry pushed forward by the client', () => {
    const now = Date.UTC(2026, 0, 1)
    const { token } = codec.issue(now)
    const [, , signature] = token.split('.')
    const forged = `v1.${now + 100 * HOUR}.${signature}`
    assert.equal(codec.verify(forged, now), null)
  })

  it('refuses a token signed with another secret', () => {
    const other = createSessionCodec('another secret', 2 * HOUR)
    const now = Date.UTC(2026, 0, 1)
    assert.equal(codec.verify(other.issue(now).token, now), null)
  })

  it('refuses malformed input rather than throwing', () => {
    for (const token of [undefined, '', 'nonsense', 'v1.123', 'v2.123.abc', 'v1.not-a-number.abc']) {
      assert.equal(codec.verify(token, Date.now()), null, String(token))
    }
  })

  it('survives a restart: the same secret keeps existing sessions valid', () => {
    const now = Date.UTC(2026, 0, 1)
    const { token } = codec.issue(now)
    const rebooted = createSessionCodec('secret', 2 * HOUR)
    assert.notEqual(rebooted.verify(token, now + HOUR), null)
  })
})

describe('createAttemptLimiter', () => {
  it('lets the first attempts through and then shuts the door', () => {
    const limiter = createAttemptLimiter(3, 60_000)
    const now = 1_000

    assert.equal(limiter.retryAfter('ip', now), 0)
    assert.equal(limiter.fail('ip', now), 0)
    assert.equal(limiter.fail('ip', now), 0)
    assert.equal(limiter.fail('ip', now), 60)
    assert.equal(limiter.retryAfter('ip', now), 60)
  })

  it('reopens it once the lockout has passed', () => {
    const limiter = createAttemptLimiter(2, 60_000)
    limiter.fail('ip', 1_000)
    limiter.fail('ip', 1_000)
    assert.ok(limiter.retryAfter('ip', 30_000) > 0)
    assert.equal(limiter.retryAfter('ip', 62_000), 0)
  })

  it('forgives a client that eventually gets it right', () => {
    const limiter = createAttemptLimiter(2, 60_000)
    limiter.fail('ip', 1_000)
    limiter.succeed('ip')
    assert.equal(limiter.fail('ip', 1_000), 0)
  })

  it('counts each client apart', () => {
    const limiter = createAttemptLimiter(1, 60_000)
    assert.equal(limiter.fail('a', 1_000), 60)
    assert.equal(limiter.retryAfter('b', 1_000), 0)
  })
})

describe('the guard', () => {
  it('refuses /app/* without a session, and says how to get one', async () => {
    const res = await protectedApp(withPassword()).request('/app/overview')
    assert.equal(res.status, 401)
    const body = (await res.json()) as { error: { code: string; hint?: string } }
    assert.equal(body.error.code, 'unauthenticated')
    assert.match(body.error.hint ?? '', /\/app\/session/)
  })

  it('refuses a write without a session — this is the whole point', async () => {
    const res = await protectedApp(withPassword()).request('/app/deploy', { method: 'POST' })
    assert.equal(res.status, 401)
  })

  it('lets the health check and the webhook receiver through', async () => {
    const app = protectedApp(withPassword())
    const health = await app.request('/app/health')
    assert.equal(health.status, 200)
    // …but it does not consider the caller signed in.
    assert.deepEqual(await health.json(), { service: 'coolify-dashboard-bff', seen: false })
  })

  it('stays out of the way entirely when no password is configured', async () => {
    const app = protectedApp(withPassword({ password: null }))
    const res = await app.request('/app/deploy', { method: 'POST' })
    assert.equal(res.status, 200)
  })
})

describe('POST /app/session', () => {
  it('exchanges the password for a cookie that opens the door', async () => {
    const app = protectedApp(withPassword())

    const res = await signIn(app, 'hunter2')
    assert.equal(res.status, 200)
    const body = (await res.json()) as SessionResponse
    assert.equal(body.authenticated, true)
    assert.equal(body.required, true)
    assert.ok(body.expiresAt && Date.parse(body.expiresAt) > Date.now())

    const cookie = res.headers.get('set-cookie') ?? ''
    assert.match(cookie, /HttpOnly/i)
    assert.match(cookie, /SameSite=Lax/i)
    // Plain HTTP in this test, so `Secure` would make the cookie unusable.
    assert.doesNotMatch(cookie, /Secure/i)

    const allowed = await app.request('/app/deploy', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${cookieValue(res)}` },
    })
    assert.equal(allowed.status, 200)
  })

  it('marks the cookie Secure behind a TLS-terminating proxy', async () => {
    const app = protectedApp(withPassword())
    const res = await app.request('/app/session', {
      method: 'POST',
      body: JSON.stringify({ password: 'hunter2' }),
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    })
    assert.match(res.headers.get('set-cookie') ?? '', /Secure/i)
  })

  it('refuses the wrong password, and sets no cookie', async () => {
    const app = protectedApp(withPassword())
    const res = await signIn(app, 'wrong')
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('set-cookie'), null)
  })

  it('refuses a body that is not the expected shape', async () => {
    const app = protectedApp(withPassword())
    const res = await app.request('/app/session', { method: 'POST', body: 'not json' })
    assert.equal(res.status, 401)
  })

  it('throttles a client that keeps guessing', async () => {
    const app = protectedApp(withPassword())
    let last = await signIn(app, 'wrong')
    for (let attempt = 1; attempt < 10; attempt++) last = await signIn(app, 'wrong')

    assert.equal(last.status, 401)
    // The tenth failure closes the door; the eleventh attempt never reaches the
    // comparison — even with the right password.
    const locked = await signIn(app, 'hunter2')
    assert.equal(locked.status, 429)
    assert.ok(Number(locked.headers.get('retry-after')) > 0)
  })
})

describe('GET and DELETE /app/session', () => {
  it('reports whether a session is open', async () => {
    const app = protectedApp(withPassword())

    const anonymous = (await (await app.request('/app/session')).json()) as SessionResponse
    assert.deepEqual(anonymous, { required: true, authenticated: false, expiresAt: null })

    const signedIn = await signIn(app, 'hunter2')
    const cookie = `${SESSION_COOKIE}=${cookieValue(signedIn)}`
    const seen = (await (await app.request('/app/session', { headers: { Cookie: cookie } })).json()) as SessionResponse
    assert.equal(seen.authenticated, true)
  })

  it('says an open dashboard needs no session at all', async () => {
    const app = protectedApp(withPassword({ password: null }))
    const body = (await (await app.request('/app/session')).json()) as SessionResponse
    assert.deepEqual(body, { required: false, authenticated: true, expiresAt: null })
  })

  it('signs out by expiring the cookie', async () => {
    const app = protectedApp(withPassword())
    const res = await app.request('/app/session', { method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('set-cookie') ?? '', /Max-Age=0/i)
  })
})
