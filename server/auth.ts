/**
 * The dashboard's own front door (phase 7 of docs/roadmap.md).
 *
 * Until this file existed, the honest answer to "can I put it on a domain?" was
 * no: `/app/deploy` and `/app/applications/{uuid}/stop` are unauthenticated
 * write endpoints, so anything that could reach the BFF could stop production.
 * The documented workaround — bind to loopback, put a proxy in front — is a
 * real constraint rather than a design choice, and this removes it.
 *
 * Three decisions shape what follows:
 *
 *  1. **One password, no user table.** This is a companion to a Coolify
 *     instance, not a multi-tenant product; the Coolify token it holds is
 *     already a single shared credential. A user table would suggest a
 *     separation of privilege that does not exist behind it.
 *  2. **A signed cookie, not a server-side session store.** Nothing needs to be
 *     remembered between requests, so nothing is: the cookie carries its own
 *     expiry and an HMAC over it. Restarting the container does not log anyone
 *     out, because the key is derived from configuration rather than generated
 *     at boot.
 *  3. **The password is never a bearer token.** It is exchanged once for a
 *     session at `POST /app/session`; no header carries it, so it stays out of
 *     proxy logs and out of `EventSource`, which cannot set headers at all.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AuthStatus, BffErrorResponse, SessionResponse } from '../shared/bff'

export interface AuthConfig {
  /** `null` leaves the dashboard open — the pre-phase-7 behaviour, warned about at boot. */
  password: string | null
  /**
   * Key material for the session signature. Falling back to the password is
   * deliberate: it means changing the password invalidates every session that
   * was issued under the old one, which is what a password change is for.
   */
  sessionSecret: string | null
  sessionTtlMs: number
}

export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60_000

/** Attempts allowed per client before the door closes for `LOCKOUT_MS`. */
const MAX_ATTEMPTS = 10
const LOCKOUT_MS = 5 * 60_000

export const SESSION_COOKIE = 'coolify_dashboard_session'

/* ------------------------------------------------------------- signing ---- */

/**
 * Both sides are hashed before the comparison so that `timingSafeEqual` — which
 * throws on a length mismatch, and would otherwise leak the password's length —
 * always sees two 32-byte buffers.
 */
export function passwordMatches(expected: string, received: unknown): boolean {
  if (!expected || typeof received !== 'string' || !received) return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(expected), digest(received))
}

/** Domain separation: the same secret must not sign two different things. */
const deriveKey = (secret: string) =>
  createHmac('sha256', secret).update('coolify-dashboard/session/v1').digest()

const sign = (key: Buffer, message: string) =>
  createHmac('sha256', key).update(message).digest('base64url')

export interface SessionCodec {
  /** A cookie value good until `now + ttl`, and the moment it expires. */
  issue(now?: number): { token: string; expiresAt: number }
  /** The expiry it was issued with, or `null` when it is forged, stale or foreign. */
  verify(token: string | undefined, now?: number): number | null
}

/**
 * `v1.<expiry>.<signature>`. The expiry travels in clear text and is covered by
 * the signature: a client that edits it invalidates it, and the server needs no
 * memory of what it handed out.
 */
export function createSessionCodec(secret: string, ttlMs = DEFAULT_SESSION_TTL_MS): SessionCodec {
  const key = deriveKey(secret)

  return {
    issue(now = Date.now()) {
      const expiresAt = now + ttlMs
      const body = `v1.${expiresAt}`
      return { token: `${body}.${sign(key, body)}`, expiresAt }
    },

    verify(token, now = Date.now()) {
      if (!token) return null
      const parts = token.split('.')
      if (parts.length !== 3 || parts[0] !== 'v1') return null
      const [, rawExpiry, signature] = parts as [string, string, string]

      const expected = sign(key, `v1.${rawExpiry}`)
      // Same-length base64url digests, so the comparison is safe to make in
      // constant time — and it happens *before* the expiry is trusted at all.
      if (signature.length !== expected.length) return null
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null

      const expiresAt = Number(rawExpiry)
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
      return expiresAt
    },
  }
}

/* ------------------------------------------------------------ throttle ---- */

export interface AttemptLimiter {
  /** Seconds to wait, or `0` when the caller may try now. */
  retryAfter(key: string, now?: number): number
  /** Records a failure and returns the seconds the caller must now wait. */
  fail(key: string, now?: number): number
  /** A correct password clears the count — a legitimate user is not a suspect. */
  succeed(key: string): void
}

/**
 * A password is one guess away from being brute-forced at HTTP speed, so
 * failures are counted and the door shuts for five minutes after ten of them.
 *
 * The bucket is the client address, which behind a reverse proxy is the proxy —
 * making the limit effectively global. That is the safe direction to be wrong
 * in: `X-Forwarded-For` is set by whoever sends it, so keying on it would let
 * an attacker rotate the header and never be throttled at all. The cost is that
 * someone hammering the login can lock the owner out for five minutes; the
 * lockout is short for exactly that reason.
 */
export function createAttemptLimiter(max = MAX_ATTEMPTS, lockoutMs = LOCKOUT_MS): AttemptLimiter {
  const failures = new Map<string, { count: number; until: number }>()

  const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000))

  return {
    retryAfter(key, now = Date.now()) {
      const entry = failures.get(key)
      if (!entry) return 0
      if (entry.until <= now) {
        failures.delete(key)
        return 0
      }
      return entry.count >= max ? seconds(entry.until - now) : 0
    },

    fail(key, now = Date.now()) {
      const entry = failures.get(key)
      // The window slides on every failure: a patient attacker gains nothing by
      // spreading guesses out just under the limit.
      const count = entry && entry.until > now ? entry.count + 1 : 1
      failures.set(key, { count, until: now + lockoutMs })
      return count >= max ? seconds(lockoutMs) : 0
    },

    succeed(key) {
      failures.delete(key)
    },
  }
}

/* ---------------------------------------------------------------- gate ---- */

export interface Auth {
  /** false when no password is configured: every route stays open. */
  required: boolean
  /** `null` exactly when `required` is false — there is nothing to sign. */
  codec: SessionCodec | null
  /** True once the request carries a valid session — or always, when open. */
  isAuthenticated(c: Context): boolean
  status(c: Context): AuthStatus
  /** Refuses `/app/*` without a session; mount it before the routes it protects. */
  guard: MiddlewareHandler
}

/** Paths that must answer before anyone can possibly hold a session. */
const PUBLIC_PATHS = new Set(['/app/session', '/app/health', '/app/hooks/coolify'])

/**
 * `Secure` would make the cookie unusable over the plain-HTTP origins this is
 * legitimately reached on — `http://localhost:8787` in development, a private
 * address on a home server — so it is set from what the request itself says,
 * including the header a terminating proxy adds. `SameSite=Lax` keeps it off
 * cross-site requests, which is what makes the write endpoints CSRF-safe: they
 * are all `POST`, and a cross-site `POST` arrives without this cookie.
 */
function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  if (forwarded) return forwarded === 'https'
  return new URL(c.req.url).protocol === 'https:'
}

export function createAuth(config: AuthConfig): Auth {
  const password = config.password
  const codec = password
    ? createSessionCodec(config.sessionSecret ?? password, config.sessionTtlMs)
    : null

  const isAuthenticated = (c: Context) =>
    codec === null || codec.verify(getCookie(c, SESSION_COOKIE)) !== null

  return {
    required: codec !== null,
    codec,
    isAuthenticated,
    status: c => ({ required: codec !== null, authenticated: isAuthenticated(c) }),
    guard: async (c, next) => {
      if (codec === null || PUBLIC_PATHS.has(c.req.path) || isAuthenticated(c)) return next()
      return c.json(
        {
          error: {
            code: 'unauthenticated',
            message: 'This dashboard is password-protected.',
            hint: 'Sign in first — POST /app/session with { "password": "…" }.',
          },
        } satisfies BffErrorResponse,
        401,
      )
    },
  }
}

/* -------------------------------------------------------------- routes ---- */

/**
 * `GET`, `POST` and `DELETE` on one path: the session is a resource, so reading
 * whether one exists, creating one and destroying one are the three verbs on it.
 */
export function mountSession(
  app: Hono,
  auth: Auth,
  config: AuthConfig,
  clientKey: (c: Context) => string,
): void {
  const password = config.password
  // The same codec the guard verifies with: one key, derived once.
  const codec = auth.codec
  const limiter = createAttemptLimiter()

  const answer = (c: Context, expiresAt: number | null) =>
    c.json({
      required: codec !== null,
      authenticated: codec === null || expiresAt !== null,
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    } satisfies SessionResponse)

  app.get('/app/session', c => answer(c, codec ? codec.verify(getCookie(c, SESSION_COOKIE)) : null))

  app.post('/app/session', async c => {
    if (!codec || !password) {
      // Nothing to sign in to. Answering 200 rather than 404 lets one SPA serve
      // both shapes: it asks, and an open dashboard says "you are already in".
      return answer(c, null)
    }

    const key = clientKey(c)
    const waiting = limiter.retryAfter(key)
    if (waiting > 0) {
      c.header('Retry-After', String(waiting))
      return c.json(
        {
          error: {
            code: 'rate_limited',
            message: 'Too many failed sign-in attempts.',
            hint: `Wait ${waiting}s and try again.`,
            retryAfterSeconds: waiting,
          },
        } satisfies BffErrorResponse,
        429,
      )
    }

    let submitted: unknown
    try {
      submitted = ((await c.req.json()) as { password?: unknown }).password
    } catch {
      submitted = undefined
    }

    if (!passwordMatches(password, submitted)) {
      const retryAfterSeconds = limiter.fail(key)
      console.warn(`[auth] failed sign-in from ${key}`)
      if (retryAfterSeconds) c.header('Retry-After', String(retryAfterSeconds))
      return c.json(
        {
          error: {
            code: 'unauthenticated',
            message: 'Wrong password.',
            ...(retryAfterSeconds ? { hint: 'Too many attempts — the door is shut for a few minutes.', retryAfterSeconds } : {}),
          },
        } satisfies BffErrorResponse,
        401,
      )
    }

    limiter.succeed(key)
    const { token, expiresAt } = codec.issue()
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isSecureRequest(c),
      path: '/',
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    })
    return answer(c, expiresAt)
  })

  app.delete('/app/session', c => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isSecureRequest(c) })
    return answer(c, null)
  })
}
