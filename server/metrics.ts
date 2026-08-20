/**
 * Server CPU and memory (phase 5 of docs/roadmap.md).
 *
 * Coolify has **no REST endpoint for metrics**. Its own charts come from
 * `app/Traits/HasMetrics.php`, which SSHes into the server and runs
 * `docker exec coolify-sentinel curl http://localhost:8888/api/{cpu,memory}/history`
 * against Sentinel, the agent Coolify installs on every managed host. The REST
 * API exposes only Sentinel's *configuration*
 * (`GET/PATCH /api/v1/servers/{uuid}/sentinel`), never its readings.
 *
 * docs/roadmap.md lists three ways out, and this module implements the two that live in
 * this repo:
 *
 *  - **the collector** (option 2): the same SSH round trip Coolify makes,
 *    opt-in, because it needs the server's private key mounted next to the BFF.
 *    Set `METRICS_SSH_KEY` and the Fleet gauges show real percentages.
 *  - **the degraded mode** (option 3): with no key — the default — the gauges
 *    stay empty and say *why*, distinguishing "this dashboard was never given a
 *    way to read them" from "Sentinel is switched off on that server" from
 *    "Sentinel is on but has not reported in a while". An em dash with a reason
 *    behind it is worth more than an invented percentage.
 *
 * Option 1, an upstream `GET /api/v1/servers/{uuid}/metrics`, is a patch to
 * Coolify rather than to this repo; README.md carries the sketch.
 *
 * Unlike the probes of phase 4, this loop **stops when no browser is watching**,
 * exactly like the deployment poller: a gauge has no memory to build up, so a
 * reading nobody is looking at is a wasted SSH connection.
 */

import { execFile } from 'node:child_process'
import type { MetricsSource } from '../shared/dashboard'
import { mapLimit } from './concurrency'
import type { EventHub } from './events'

/** Container name Coolify gives the agent — hard-coded there too. */
export const SENTINEL_CONTAINER = 'coolify-sentinel'
/** Sentinel binds to localhost inside the container; only `docker exec` reaches it. */
export const SENTINEL_BASE_URL = 'http://localhost:8888/api'
/** Separates the two JSON bodies of one round trip. */
export const SECTION_MARKER = '@@coolify-dashboard@@'

/**
 * A reading older than this is not shown. Sentinel's default refresh rate is
 * 10 s and it pushes every 60 s, so two minutes of silence means the agent
 * stopped collecting — not that the server is idle.
 */
export const STALE_AFTER_MS = 120_000

export type StrictHostKey = 'accept-new' | 'yes' | 'no'

export interface MetricsConfig {
  /** off unless an SSH key was provided — the collector cannot work without one */
  enabled: boolean
  intervalMs: number
  /** whole budget for one server: ssh handshake plus both curls */
  timeoutMs: number
  sshKeyPath: string | null
  /** overrides the login `GET /servers` reports (usually `root`) */
  sshUser: string | null
  strictHostKey: StrictHostKey
  concurrency: number
  /** how much history to ask Sentinel for; only the newest point is displayed */
  historyMinutes: number
  /** server names or uuids to collect from; empty means every server */
  only: string[]
}

export const DEFAULT_METRICS_CONFIG: MetricsConfig = {
  enabled: false,
  intervalMs: 30_000,
  timeoutMs: 12_000,
  sshKeyPath: null,
  sshUser: null,
  strictHostKey: 'accept-new',
  concurrency: 3,
  historyMinutes: 5,
  only: [],
}

/* ------------------------------------------------------------ commands ---- */

/**
 * Coolify's own validation of a Sentinel token
 * (`ServerSetting::isValidSentinelToken`). Checked again here for a different
 * reason: this token is interpolated into a command a remote shell parses, and
 * a character class with no quote, backtick or `$` in it is what makes that
 * interpolation safe rather than merely conventional.
 */
const SENTINEL_TOKEN = /^[A-Za-z0-9._\-+=/]+$/

export const isValidSentinelToken = (token: string): boolean => SENTINEL_TOKEN.test(token)

/** `2026-08-20T09:55:00Z` — the format `HasMetrics` sends, seconds and no millis. */
export function zulu(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * One `docker exec` running both curls, so a server costs a single SSH
 * handshake per cycle rather than two. The bodies are separated by a marker
 * because two JSON arrays printed back to back cannot be split apart again.
 *
 * Every interpolated value is constrained: the token by the regex above, `from`
 * by `zulu()`, the container name and URL by the constants. Nothing here comes
 * from a Coolify payload unchecked.
 */
export function remoteCommand(token: string, from: string, curlTimeoutSeconds: number): string {
  if (!isValidSentinelToken(token)) throw new Error('refusing to send a Sentinel token with shell metacharacters')
  const get = (metric: 'cpu' | 'memory') =>
    `curl -sS -m ${curlTimeoutSeconds} -H "Authorization: Bearer ${token}" ` +
    `"${SENTINEL_BASE_URL}/${metric}/history?from=${from}"`
  return `docker exec ${SENTINEL_CONTAINER} sh -c '${get('cpu')}; printf "\\n${SECTION_MARKER}\\n"; ${get('memory')}'`
}

export interface SshTarget {
  host: string
  user: string
  port: number
}

/**
 * Argv, never a shell string: the command is one element handed to `ssh`, and
 * the local side never gets a chance to reinterpret a hostname.
 *
 * `StrictHostKeyChecking` defaults to `accept-new` rather than Coolify's `no`.
 * Coolify already holds the keys of these servers and rotates through them
 * constantly; a dashboard talking to a fixed handful of hosts can afford to
 * pin them on first sight, and an operator running from an ephemeral container
 * with no writable `known_hosts` can still set `no` explicitly.
 */
export function sshArgs(target: SshTarget, command: string, config: MetricsConfig): string[] {
  const connectTimeout = Math.max(2, Math.round(config.timeoutMs / 2_000))
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'RequestTTY=no',
    '-o', 'LogLevel=ERROR',
    '-o', `ConnectTimeout=${connectTimeout}`,
    '-o', `StrictHostKeyChecking=${config.strictHostKey}`,
  ]
  if (config.strictHostKey === 'no') args.push('-o', 'UserKnownHostsFile=/dev/null')
  // `IdentitiesOnly` stops ssh from offering every key in the agent first and
  // tripping the server's `MaxAuthTries` before it reaches the right one.
  if (config.sshKeyPath) args.push('-i', config.sshKeyPath, '-o', 'IdentitiesOnly=yes')
  args.push('-p', String(target.port), `${target.user}@${target.host}`, command)
  return args
}

export interface RemoteResult {
  /** 0 on success; -2 when the runner killed the command on its timeout */
  code: number
  stdout: string
  stderr: string
}

export type RemoteRunner = (args: string[], timeoutMs: number) => Promise<RemoteResult>

/** Never rejects: a failed SSH is a reading the dashboard reports, not a crash. */
export const sshRunner: RemoteRunner = (args, timeoutMs) =>
  new Promise(resolve => {
    execFile('ssh', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr })
      const failure = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean }
      if (failure.killed) {
        return resolve({ code: -2, stdout, stderr: `ssh did not answer within ${timeoutMs} ms` })
      }
      resolve({
        code: typeof failure.code === 'number' ? failure.code : -1,
        stdout,
        // ENOENT here means the image has no ssh client, which is worth saying plainly.
        stderr: stderr || (failure.code === 'ENOENT' ? 'no `ssh` binary on this host' : failure.message),
      })
    })
  })

/* ------------------------------------------------------------- parsing ---- */

export interface SentinelPoint {
  at: number
  value: number
}

/** Sentinel timestamps are epoch **seconds**; anything already in ms is left alone. */
export function toMillis(time: number): number {
  return time < 1e11 ? time * 1_000 : time
}

export function splitSections(stdout: string): [string, string] | null {
  const index = stdout.indexOf(SECTION_MARKER)
  if (index === -1) return null
  return [stdout.slice(0, index), stdout.slice(index + SECTION_MARKER.length)]
}

/**
 * One Sentinel history body → points, oldest first.
 *
 * The field differs per metric, as it does in `HasMetrics`: CPU reports
 * `percent`, and a *server*'s memory reports `usedPercent` (a container's
 * reports raw `used` bytes — not something this dashboard asks for).
 * An error body is `{"error": "..."}`, which is why a non-array is inspected
 * before being rejected: "Unauthorized" is the message worth surfacing.
 */
export function parseSentinelSeries(raw: string, field: 'percent' | 'usedPercent'): SentinelPoint[] {
  const text = raw.trim()
  if (!text) throw new Error('Sentinel returned an empty body')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Sentinel returned a non-JSON body: ${text.slice(0, 120)}`)
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed) {
    throw new Error(String((parsed as { error: unknown }).error))
  }
  if (!Array.isArray(parsed)) throw new Error('Sentinel did not return a series')

  const points: SentinelPoint[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const time = Number(row.time)
    const value = Number(row[field])
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue
    points.push({ at: toMillis(time), value: Math.min(100, Math.max(0, value)) })
  }
  return points.sort((a, b) => a.at - b.at)
}

export const newest = (points: SentinelPoint[]): SentinelPoint | null => points.at(-1) ?? null

/* -------------------------------------------------------------- state ----- */

export interface MetricsTarget {
  /** server uuid */
  id: string
  name: string
  host: string
  user: string
  port: number
  /** `settings.is_metrics_enabled`, already carried by `GET /servers` */
  metricsEnabled: boolean
  reachable: boolean
}

/** What `GET /servers/{uuid}/sentinel` says, reduced to what the collector needs. */
export interface SentinelInfo {
  metricsEnabled: boolean
  /** `null` when the Coolify token lacks `read:sensitive` */
  token: string | null
  /** `sentinel_updated_at` — last time the agent reported to Coolify */
  updatedAt: number | null
}

export interface ServerMetricsReading {
  id: string
  name: string
  cpu: number | null
  mem: number | null
  source: MetricsSource
  /** one sentence, shown as-is in the Fleet tooltip */
  note: string
  /** when Sentinel took the sample, `null` when there is none */
  at: number | null
  checkedAt: number
}

export interface MetricsSnapshot {
  enabled: boolean
  lastRunAt: number | null
  servers: Map<string, ServerMetricsReading>
}

export const EMPTY_METRICS: MetricsSnapshot = { enabled: false, lastRunAt: null, servers: new Map() }

interface ServerLike {
  uuid: string
  name: string
  ip?: string
  user?: string
  port?: number
  is_reachable?: boolean
  settings?: { is_metrics_enabled?: boolean; is_sentinel_enabled?: boolean; is_reachable?: boolean }
}

/**
 * Servers worth an SSH connection: those with an address, minus anything the
 * operator left out of `METRICS_SERVERS`. A server whose Sentinel metrics are
 * off is *kept* — the collector still produces a reading for it, one that says
 * so instead of leaving the row blank.
 */
export function metricsTargets(servers: ServerLike[], config: MetricsConfig): MetricsTarget[] {
  const allowed = new Set(config.only.map(entry => entry.toLowerCase()))
  const targets: MetricsTarget[] = []

  for (const server of servers) {
    if (allowed.size > 0 && !allowed.has(server.uuid.toLowerCase()) && !allowed.has(server.name.toLowerCase())) continue
    const host = server.ip?.trim()
    if (!host) continue
    targets.push({
      id: server.uuid,
      name: server.name,
      host,
      user: config.sshUser ?? server.user?.trim() ?? 'root',
      port: server.port ?? 22,
      metricsEnabled: server.settings?.is_metrics_enabled === true,
      reachable: server.is_reachable ?? server.settings?.is_reachable ?? false,
    })
  }
  return targets
}

/**
 * Why a gauge is empty, for every server the collector produced no reading for.
 *
 * Four different silences that would otherwise render as the same em dash. The
 * first is by far the most common — it is what every default install shows —
 * and it is the only one that is a statement about this dashboard rather than
 * about the server.
 */
export function degradedMetrics(input: {
  /** the SSH collector is configured and running */
  collector: boolean
  metricsEnabled: boolean
  reachable: boolean
}): { source: MetricsSource; note: string } {
  if (!input.collector) {
    return {
      source: 'off',
      note: 'Coolify has no REST endpoint for CPU or memory. Point METRICS_SSH_KEY at a key for this server to read them from its Sentinel agent.',
    }
  }
  if (!input.reachable) {
    return { source: 'error', note: 'Coolify cannot reach this server, so its Sentinel agent cannot be queried either.' }
  }
  if (!input.metricsEnabled) {
    return {
      source: 'sentinel-off',
      note: 'Sentinel metrics are disabled on this server — turn them on in Coolify under Server → Settings → Sentinel.',
    }
  }
  return { source: 'error', note: 'No reading yet — the collector has not finished a cycle for this server.' }
}

/* --------------------------------------------------------------- loop ----- */

export interface MetricsDeps {
  config: MetricsConfig
  /** current fleet, re-read every cycle so a new server is picked up at once */
  targets: () => Promise<MetricsTarget[]>
  /** `GET /servers/{uuid}/sentinel`, cached by the caller — the token barely moves */
  sentinel: (uuid: string) => Promise<SentinelInfo>
  /** Sentinel rejected the token: the caller drops its cached copy and re-reads */
  onTokenRejected?: (uuid: string) => void
  /** told when a gauge actually moved, so open tabs refetch instead of waiting */
  hub?: EventHub
  run?: RemoteRunner
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface MetricsCollector {
  start(): void
  stop(): void
  /** Runs one cycle now and resolves when it is done — the tests' entry point. */
  runOnce(): Promise<void>
  snapshot(): MetricsSnapshot
}

/**
 * Everything the remote side said, on one line.
 *
 * Not just the first: ssh leads with warnings and concludes with the fatal
 * error, and either half can be the one that tells an operator what to fix
 * ("Identity file not accessible" + "Permission denied" is one story told in
 * two lines). Capped so a tooltip stays a tooltip.
 */
const condense = (text: string, max = 200): string => {
  const joined = text.trim().split('\n').map(line => line.trim()).filter(Boolean).join(' · ')
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined
}
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createMetricsCollector(deps: MetricsDeps): MetricsCollector {
  const { config, targets, sentinel, hub } = deps
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout))
  const run = deps.run ?? sshRunner
  // Below ssh's own budget, so a slow Sentinel surfaces as curl's error rather
  // than as an ssh killed halfway through printing the first body.
  const curlSeconds = Math.max(2, Math.round(config.timeoutMs / 1_000) - 3)

  const servers = new Map<string, ServerMetricsReading>()

  let running = false
  let timer: unknown = null
  let inFlight: Promise<void> | null = null
  let lastRunAt: number | null = null

  const reading = (
    target: MetricsTarget,
    checkedAt: number,
    rest: { cpu: number | null; mem: number | null; source: MetricsSource; note: string; at?: number | null },
  ): ServerMetricsReading => ({
    id: target.id,
    name: target.name,
    checkedAt,
    at: rest.at ?? null,
    cpu: rest.cpu,
    mem: rest.mem,
    source: rest.source,
    note: rest.note,
  })

  const blank = (target: MetricsTarget, checkedAt: number, source: MetricsSource, note: string) =>
    reading(target, checkedAt, { cpu: null, mem: null, source, note })

  async function collect(target: MetricsTarget): Promise<ServerMetricsReading> {
    const checkedAt = now()

    if (!target.reachable || !target.metricsEnabled) {
      const degraded = degradedMetrics({ collector: true, metricsEnabled: target.metricsEnabled, reachable: target.reachable })
      return blank(target, checkedAt, degraded.source, degraded.note)
    }

    let info: SentinelInfo
    try {
      info = await sentinel(target.id)
    } catch (error) {
      return blank(target, checkedAt, 'error', `Could not read the Sentinel settings of ${target.name}: ${messageOf(error)}`)
    }

    if (!info.metricsEnabled) {
      const degraded = degradedMetrics({ collector: true, metricsEnabled: false, reachable: true })
      return blank(target, checkedAt, degraded.source, degraded.note)
    }
    if (!info.token) {
      return blank(
        target,
        checkedAt,
        'error',
        'Coolify withheld the Sentinel token — the API token needs the `read:sensitive` ability to read it.',
      )
    }
    if (!isValidSentinelToken(info.token)) {
      return blank(target, checkedAt, 'error', 'Coolify returned a Sentinel token this collector will not pass to a shell.')
    }

    const from = zulu(checkedAt - config.historyMinutes * 60_000)
    const result = await run(sshArgs(target, remoteCommand(info.token, from, curlSeconds), config), config.timeoutMs)

    if (result.code !== 0) {
      const detail = condense(result.stderr) || `ssh exited with ${result.code}`
      return blank(target, checkedAt, 'error', `Cannot read Sentinel on ${target.user}@${target.host}: ${detail}`)
    }

    const sections = splitSections(result.stdout)
    if (!sections) {
      const detail = condense(result.stdout) || 'no output'
      return blank(target, checkedAt, 'error', `Sentinel did not answer on ${target.name}: ${detail}`)
    }

    let cpuPoints: SentinelPoint[]
    let memPoints: SentinelPoint[]
    try {
      cpuPoints = parseSentinelSeries(sections[0], 'percent')
      memPoints = parseSentinelSeries(sections[1], 'usedPercent')
    } catch (error) {
      const detail = messageOf(error)
      // A token regenerated on the Coolify side outlives our cached copy; drop
      // it so the next cycle asks for the current one instead of failing again.
      if (/unauthor/i.test(detail)) {
        deps.onTokenRejected?.(target.id)
        return blank(
          target,
          checkedAt,
          'error',
          `Sentinel on ${target.name} rejected the token. It was probably regenerated — restarting the Sentinel container makes it match again.`,
        )
      }
      return blank(target, checkedAt, 'error', `Sentinel on ${target.name}: ${detail}`)
    }

    const cpu = newest(cpuPoints)
    const mem = newest(memPoints)
    const at = Math.max(cpu?.at ?? 0, mem?.at ?? 0)

    if (at === 0) {
      return blank(
        target,
        checkedAt,
        'stale',
        `Sentinel is running on ${target.name} but recorded no sample in the last ${config.historyMinutes} min.${heartbeat(info.updatedAt, checkedAt)}`,
      )
    }
    if (checkedAt - at > STALE_AFTER_MS) {
      return blank(
        target,
        checkedAt,
        'stale',
        `Sentinel's newest reading for ${target.name} is ${Math.round((checkedAt - at) / 60_000)} min old, too stale to show as current.${heartbeat(info.updatedAt, checkedAt)}`,
      )
    }

    return reading(target, checkedAt, {
      cpu: cpu?.value ?? null,
      mem: mem?.value ?? null,
      at,
      source: 'sentinel',
      note: `Measured by Sentinel on ${target.name}, ${Math.max(0, Math.round((checkedAt - at) / 1_000))} s ago.`,
    })
  }

  async function cycle(): Promise<void> {
    let fleet: MetricsTarget[]
    try {
      fleet = await targets()
    } catch (error) {
      // Coolify is unreachable: keep the last readings rather than blanking the
      // gauges. `/app/overview` reports the upstream failure on its own.
      console.error(`[metrics] could not read the fleet: ${messageOf(error)}`)
      return
    }

    const live = new Set(fleet.map(target => target.id))
    for (const id of [...servers.keys()]) if (!live.has(id)) servers.delete(id)

    const results = await mapLimit(fleet, config.concurrency, collect)
    let moved = false
    for (const result of results) {
      if (!moved && visiblyDiffers(servers.get(result.id), result)) moved = true
      servers.set(result.id, result)
    }

    lastRunAt = now()

    // Without this the gauges would only move on the SPA's own 60 s safety-net
    // poll — half the reason for reading them every 30 s. It costs nothing
    // upstream: `/app/overview` answers a refetch from the same TTL cache, and
    // the collector only runs at all while a tab is open to receive this.
    if (moved) hub?.publish({ type: 'overview-changed', at: new Date(lastRunAt).toISOString(), reason: 'metrics' })
  }

  function schedule(): void {
    if (!running) return
    timer = setTimer(tick, config.intervalMs)
  }

  function tick(): void {
    if (inFlight) return
    timer = null
    inFlight = cycle()
      .catch(error => console.error('[metrics] cycle failed', error))
      .finally(() => {
        inFlight = null
        schedule()
      })
  }

  return {
    start() {
      if (running || !config.enabled) return
      running = true
      tick()
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
      return { enabled: config.enabled, lastRunAt, servers }
    },
  }
}

/** " Coolify last heard from the agent 4 min ago." — empty when never. */
function heartbeat(updatedAt: number | null, now: number): string {
  if (updatedAt === null) return ''
  const minutes = Math.round((now - updatedAt) / 60_000)
  if (minutes <= 1) return ' Coolify heard from the agent less than a minute ago.'
  if (minutes < 60) return ` Coolify last heard from the agent ${minutes} min ago.`
  return ` Coolify last heard from the agent ${Math.round(minutes / 60)} h ago.`
}

/**
 * Whether a reader would see a difference — the only reason to make every open
 * tab refetch. The gauges round to whole percents, so comparing the raw floats
 * would fire on noise that never reaches the screen.
 */
export function visiblyDiffers(previous: ServerMetricsReading | undefined, next: ServerMetricsReading): boolean {
  if (!previous) return true
  if (previous.source !== next.source || previous.note !== next.note) return true
  const same = (a: number | null, b: number | null) =>
    a === null || b === null ? a === b : Math.round(a) === Math.round(b)
  return !same(previous.cpu, next.cpu) || !same(previous.mem, next.mem)
}
