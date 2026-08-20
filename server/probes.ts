/**
 * Outbound probes (phase 4 of docs/roadmap.md).
 *
 * Coolify tracks no uptime at all and exposes no certificate information: it
 * knows whether *it* can SSH into a server and what Docker says about a
 * container, which is not the same question as "does the site answer?". So the
 * BFF asks that question itself, from wherever it runs.
 *
 * Three probes, three different truths:
 *
 *  - **HTTP** on every application `fqdn`, every minute. Each result is one row
 *    in SQLite, so the uptime percentage is measured rather than asserted, and
 *    it survives a restart.
 *  - **TLS** on the same hosts, hourly — a certificate does not change between
 *    two minutes, and the handshake is the only way to learn its expiry.
 *  - **TCP** on each server's SSH port, for the latency figure the Fleet panel
 *    has been rendering as an em dash since phase 1.
 *
 * Unlike the poller, this loop does **not** stop when no browser is watching:
 * an uptime measured only while someone looks is not an uptime. It costs
 * nothing upstream — these requests go to the user's own applications, not to
 * the Coolify API, and so spend none of the 200 req/min budget of appendix B.
 */

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { EventHub } from './events'
import { mapLimit } from './concurrency'
import type { ProbeStats, ProbeStore } from './store'

export const DAY_MS = 24 * 60 * 60_000

/** Below this many samples a percentage says more about the BFF's uptime than
    the application's, so the dashboard shows an em dash instead. */
export const MIN_UPTIME_SAMPLES = 5

/** Consecutive failures before the probe is allowed to call an application
    down: one timeout is a hiccup, three minutes of them is an outage. */
export const FAILURES_BEFORE_DOWN = 3

/** Identifies the dashboard in the access logs of whatever it probes. */
const USER_AGENT = 'coolify-dashboard-probe/1 (+uptime check)'

export interface ProbeConfig {
  enabled: boolean
  intervalMs: number
  timeoutMs: number
  tlsIntervalMs: number
  /** how far back the uptime percentage looks */
  windowMs: number
  retentionMs: number
  /** how many probes run at once */
  concurrency: number
  /** application names or uuids to probe; empty means "every public fqdn" */
  only: string[]
}

export const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  enabled: true,
  intervalMs: 60_000,
  timeoutMs: 5_000,
  tlsIntervalMs: 60 * 60_000,
  windowMs: DAY_MS,
  retentionMs: 7 * DAY_MS,
  concurrency: 6,
  only: [],
}

/* ---------------------------------------------------------- one probe ----- */

export interface HttpResult {
  /** the host answered — a 4xx is an answer, a 502 from the proxy is not */
  ok: boolean
  status: number | null
  latencyMs: number | null
  error: string | null
}

export interface TlsResult {
  /** expiry of the leaf certificate, ms epoch */
  validTo: number | null
  /** false when the chain does not validate (self-signed, expired, wrong host) */
  trusted: boolean
  error: string | null
}

export interface TcpResult {
  ok: boolean
  latencyMs: number | null
  error: string | null
}

const reason = (cause: unknown): string => {
  if (cause instanceof Error) {
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') return 'timed out'
    // fetch wraps DNS/TCP/TLS failures; the cause carries the useful code
    const code = (cause.cause as { code?: string } | undefined)?.code
    return code ?? cause.message
  }
  return String(cause)
}

/**
 * One HTTP request, headers only.
 *
 * `redirect: 'manual'` on purpose: a 301 *is* an answer, and following it could
 * walk the probe off the user's infrastructure onto whatever the redirect
 * points at. The body is cancelled rather than read — the dashboard needs the
 * status line, not the home page.
 *
 * A 5xx counts as down because that is what a stopped container looks like
 * through Coolify's proxy; a 401 or 404 counts as up, because something served
 * it.
 */
export async function checkHttp(url: string, timeoutMs: number, now: () => number = Date.now): Promise<HttpResult> {
  const started = now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const latencyMs = now() - started
    await res.body?.cancel().catch(() => {})
    return { ok: res.status < 500, status: res.status, latencyMs, error: res.status < 500 ? null : `HTTP ${res.status}` }
  } catch (cause) {
    return { ok: false, status: null, latencyMs: null, error: reason(cause) }
  }
}

/**
 * TLS handshake for the sole purpose of reading the peer certificate.
 *
 * `rejectUnauthorized: false` is deliberate and is *not* a downgrade: an
 * expired or self-signed certificate is exactly what this probe exists to
 * report, and a validating handshake would abort before we could read the
 * dates. Nothing is sent over the socket and no data is read from it.
 */
export function checkTls(host: string, port: number, timeoutMs: number): Promise<TlsResult> {
  return new Promise(resolve => {
    let settled = false
    const finish = (result: TlsResult) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    const socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate()
      const validTo = cert?.valid_to ? Date.parse(cert.valid_to) : NaN
      finish({
        validTo: Number.isNaN(validTo) ? null : validTo,
        trusted: socket.authorized,
        error: socket.authorized ? null : (socket.authorizationError?.toString() ?? 'certificate not trusted'),
      })
    })

    socket.once('timeout', () => finish({ validTo: null, trusted: false, error: 'timed out' }))
    socket.once('error', (error: Error) => finish({ validTo: null, trusted: false, error: reason(error) }))
  })
}

/** Round-trip of a TCP handshake — the closest thing to a ping a container can do. */
export function checkTcp(
  host: string,
  port: number,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<TcpResult> {
  return new Promise(resolve => {
    const started = now()
    let settled = false
    const finish = (result: TcpResult) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    const socket = netConnect({ host, port, timeout: timeoutMs }, () =>
      finish({ ok: true, latencyMs: now() - started, error: null }),
    )
    socket.once('timeout', () => finish({ ok: false, latencyMs: null, error: 'timed out' }))
    socket.once('error', (error: Error) => finish({ ok: false, latencyMs: null, error: reason(error) }))
  })
}

/* -------------------------------------------------------------- targets --- */

export interface HttpTarget {
  /** application uuid */
  id: string
  name: string
  url: string
  host: string
  port: number
  https: boolean
}

export interface TcpTarget {
  /** server uuid */
  id: string
  name: string
  host: string
  port: number
}

/** Structural shapes, so this module never has to know the Coolify API types. */
interface AppLike { uuid: string; name: string; fqdn?: string | null }
interface ServerLike { uuid: string; name: string; ip?: string; port?: number }

/**
 * Applications worth probing: those with a public domain, minus anything the
 * operator left out of `PROBE_APPS`. An application without an `fqdn` is
 * internal (a worker, a queue) and has nothing to answer an HTTP request with.
 */
export function httpTargets(applications: AppLike[], only: string[] = []): HttpTarget[] {
  const allowed = new Set(only.map(entry => entry.toLowerCase()))
  const targets: HttpTarget[] = []

  for (const app of applications) {
    if (allowed.size > 0 && !allowed.has(app.uuid.toLowerCase()) && !allowed.has(app.name.toLowerCase())) continue
    const target = parseTarget(app.fqdn)
    if (!target) continue
    targets.push({ id: app.uuid, name: app.name, ...target })
  }
  return targets
}

/** `fqdn` is a comma-separated list and the scheme is optional. */
export function parseTarget(fqdn: string | null | undefined): Omit<HttpTarget, 'id' | 'name'> | null {
  const first = (fqdn ?? '').split(',').map(part => part.trim()).find(Boolean)
  if (!first) return null
  try {
    const url = new URL(/^https?:\/\//i.test(first) ? first : `https://${first}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const https = url.protocol === 'https:'
    return {
      url: url.toString(),
      host: url.hostname,
      port: url.port ? Number(url.port) : https ? 443 : 80,
      https,
    }
  } catch {
    return null
  }
}

export function tcpTargets(servers: ServerLike[]): TcpTarget[] {
  return servers
    .filter((server): server is ServerLike & { ip: string } => Boolean(server.ip?.trim()))
    .map(server => ({ id: server.uuid, name: server.name, host: server.ip.trim(), port: server.port ?? 22 }))
}

/* ---------------------------------------------------------------- state --- */

export interface TlsState {
  validTo: number | null
  trusted: boolean
  daysLeft: number | null
  checkedAt: number
  error: string | null
}

export interface AppProbe {
  id: string
  name: string
  url: string
  host: string
  lastAt: number | null
  /** `null` before the first result */
  up: boolean | null
  status: number | null
  latencyMs: number | null
  error: string | null
  consecutiveFailures: number
  /** `null` until MIN_UPTIME_SAMPLES results are in the window */
  uptimePct: number | null
  samples: number
  avgLatencyMs: number | null
  tls: TlsState | null
}

export interface ServerProbe {
  id: string
  name: string
  host: string
  port: number
  lastAt: number | null
  reachable: boolean | null
  latencyMs: number | null
  error: string | null
}

export interface ProbeSnapshot {
  enabled: boolean
  lastRunAt: number | null
  windowMs: number
  applications: Map<string, AppProbe>
  servers: Map<string, ServerProbe>
}

export const EMPTY_SNAPSHOT: ProbeSnapshot = {
  enabled: false,
  lastRunAt: null,
  windowMs: DAY_MS,
  applications: new Map(),
  servers: new Map(),
}

/** "99.98 %" — two decimals where they carry information, none where they don't. */
export function formatUptime(pct: number): string {
  if (pct >= 99.995) return '100 %'
  if (pct >= 99) return `${pct.toFixed(2)} %`
  if (pct >= 90) return `${pct.toFixed(1)} %`
  return `${Math.round(pct)} %`
}

export function daysUntil(at: number, now: number): number {
  return Math.floor((at - now) / DAY_MS)
}

/* ---------------------------------------------------------------- loop ---- */

export interface ProberDeps {
  store: ProbeStore
  config: ProbeConfig
  /** current fleet, re-read every cycle so a new application is probed within a minute */
  targets: () => Promise<{ applications: HttpTarget[]; servers: TcpTarget[] }>
  hub?: EventHub
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** injected by the tests, which have no network */
  http?: typeof checkHttp
  tls?: typeof checkTls
  tcp?: typeof checkTcp
}

export interface Prober {
  start(): void
  stop(): void
  /** Runs one cycle now and resolves when it is done — the tests' entry point. */
  runOnce(): Promise<void>
  snapshot(): ProbeSnapshot
}

export function createProber(deps: ProberDeps): Prober {
  const { store, config, targets, hub } = deps
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout))
  const http = deps.http ?? checkHttp
  const tls = deps.tls ?? checkTls
  const tcp = deps.tcp ?? checkTcp

  const applications = new Map<string, AppProbe>()
  const servers = new Map<string, ServerProbe>()

  let running = false
  let timer: unknown = null
  let inFlight: Promise<void> | null = null
  let lastRunAt: number | null = null
  let lastPruneAt = 0

  const at = () => new Date(now()).toISOString()

  /** State transitions are the only thing worth interrupting a human for. */
  function announce(target: HttpTarget, wasDown: boolean, isUp: boolean, failures: number): void {
    if (!hub) return
    // Exactly at the threshold: the fourth failure in a row is not news again.
    if (!isUp && failures === FAILURES_BEFORE_DOWN) {
      hub.publish({
        type: 'toast',
        at: at(),
        message: `${target.name} stopped answering on ${target.host}`,
        tone: 'err',
      })
      hub.publish({ type: 'overview-changed', at: at(), reason: `probe: ${target.name} down` })
      return
    }
    // Recovery is only news if we had said it was down.
    if (isUp && wasDown) {
      hub.publish({ type: 'toast', at: at(), message: `${target.name} is answering again`, tone: 'ok' })
      hub.publish({ type: 'overview-changed', at: at(), reason: `probe: ${target.name} up` })
    }
  }

  function applyStats(entry: AppProbe, stats: ProbeStats): void {
    entry.samples = stats.samples
    entry.uptimePct = stats.samples >= MIN_UPTIME_SAMPLES ? stats.uptimePct : null
    entry.avgLatencyMs = stats.avgLatencyMs
  }

  async function probeApp(target: HttpTarget): Promise<void> {
    const previous = applications.get(target.id)
    const result = await http(target.url, config.timeoutMs, now)
    const stamp = now()

    store.recordProbe(target.id, stamp, result.ok, result.latencyMs)

    // `announce` needs the count *after* this result: 3 failures in a row is
    // what turns a hiccup into an outage.
    const failures = result.ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1
    const wasDown = (previous?.consecutiveFailures ?? 0) >= FAILURES_BEFORE_DOWN

    const entry: AppProbe = {
      id: target.id,
      name: target.name,
      url: target.url,
      host: target.host,
      lastAt: stamp,
      up: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error,
      consecutiveFailures: failures,
      uptimePct: previous?.uptimePct ?? null,
      samples: previous?.samples ?? 0,
      avgLatencyMs: previous?.avgLatencyMs ?? null,
      tls: previous?.tls ?? null,
    }
    applyStats(entry, store.probeStats(target.id, stamp - config.windowMs))
    applications.set(target.id, entry)

    announce(target, wasDown, result.ok, failures)

    if (target.https && shouldCheckTls(previous?.tls ?? null, stamp)) {
      const certificate = await tls(target.host, target.port, config.timeoutMs)
      const live = applications.get(target.id)
      if (live) {
        live.tls = {
          validTo: certificate.validTo,
          trusted: certificate.trusted,
          daysLeft: certificate.validTo === null ? null : daysUntil(certificate.validTo, stamp),
          checkedAt: stamp,
          error: certificate.error,
        }
      }
    }
  }

  function shouldCheckTls(previous: TlsState | null, stamp: number): boolean {
    return previous === null || stamp - previous.checkedAt >= config.tlsIntervalMs
  }

  async function probeServer(target: TcpTarget): Promise<void> {
    const result = await tcp(target.host, target.port, config.timeoutMs, now)
    servers.set(target.id, {
      id: target.id,
      name: target.name,
      host: target.host,
      port: target.port,
      lastAt: now(),
      reachable: result.ok,
      latencyMs: result.latencyMs,
      error: result.error,
    })
  }

  async function cycle(): Promise<void> {
    let fleet: { applications: HttpTarget[]; servers: TcpTarget[] }
    try {
      fleet = await targets()
    } catch (error) {
      // Coolify is unreachable: keep the last results rather than forgetting
      // what we knew. The overview route reports the upstream failure already.
      console.error(`[probes] could not read the fleet: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    // Drop what is no longer in the fleet, so a deleted application stops
    // showing an uptime that is no longer being measured.
    const liveApps = new Set(fleet.applications.map(target => target.id))
    for (const id of [...applications.keys()]) if (!liveApps.has(id)) applications.delete(id)
    const liveServers = new Set(fleet.servers.map(target => target.id))
    for (const id of [...servers.keys()]) if (!liveServers.has(id)) servers.delete(id)

    await mapLimit(fleet.applications, config.concurrency, probeApp)
    await mapLimit(fleet.servers, config.concurrency, probeServer)

    lastRunAt = now()
    if (lastRunAt - lastPruneAt >= 60 * 60_000) {
      lastPruneAt = lastRunAt
      store.pruneProbes(lastRunAt - config.retentionMs)
    }
  }

  function schedule(): void {
    if (!running) return
    timer = setTimer(run, config.intervalMs)
  }

  function run(): void {
    if (inFlight) return
    timer = null
    inFlight = cycle()
      .catch(error => console.error('[probes] cycle failed', error))
      .finally(() => {
        inFlight = null
        schedule()
      })
  }

  return {
    start() {
      if (running || !config.enabled) return
      running = true
      run()
    },

    stop() {
      running = false
      if (timer !== null) clearTimer(timer)
      timer = null
    },

    async runOnce() {
      await cycle()
    },

    snapshot() {
      return {
        enabled: config.enabled,
        lastRunAt,
        windowMs: config.windowMs,
        applications,
        servers,
      }
    },
  }
}
