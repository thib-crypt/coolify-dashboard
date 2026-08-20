/**
 * Pure functions from Coolify API payloads to the `Dashboard` model.
 *
 * Nothing here does I/O or reads the clock: every function that needs "now"
 * takes it as an argument, which is what makes the whole mapping layer
 * testable (see mappers.test.ts).
 */

import { CronExpressionParser } from 'cron-parser'
import type * as Api from '../../shared/coolify-api'
import type {
  Application,
  Deployment,
  DeploymentState,
  FleetTotals,
  Insight,
  Kpi,
  MetricsSource,
  PaletteAction,
  Server,
  Timeline,
} from '../../shared/dashboard'

export const DAY_MS = 24 * 60 * 60_000

/* ------------------------------------------------------------------ time -- */

/**
 * Coolify mixes two datetime formats: ISO-8601 with microseconds
 * (`2026-08-12T07:46:45.000000Z`) and bare SQL datetimes (`2026-08-17 12:02:06`).
 * The bare form has no zone, so `Date.parse` reads it as **local** time while
 * Coolify stores UTC — that silently skews every duration by the host's offset.
 */
export function parseApiDate(value: string | null | undefined): number | null {
  if (!value) return null
  const text = value.trim()
  if (!text) return null
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)
  const ms = Date.parse(naive ? `${text.replace(' ', 'T')}Z` : text)
  return Number.isNaN(ms) ? null : ms
}

/** "1m 42s" — matches the mockup's typography (seconds padded past a minute). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

export function formatRelative(at: number, now: number): string {
  const delta = now - at
  if (delta < 0) return 'just now'
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(delta / 3_600_000)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(delta / DAY_MS)
  if (days === 1) return 'yesterday'
  return `${days} d ago`
}

export function formatClock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/* ---------------------------------------------------------- resources ----- */

export interface ParsedStatus {
  /** `running`, `exited`, `restarting`, `degraded`, … */
  state: string
  /** `healthy`, `unhealthy`, `unknown` */
  health: string
}

/** Coolify stores container state as `"<state>:<health>"`, e.g. `running:healthy`. */
export function parseResourceStatus(raw: string | null | undefined): ParsedStatus {
  const [state = '', health = ''] = (raw ?? '').trim().split(':')
  return {
    state: state.toLowerCase() || 'unknown',
    health: health.toLowerCase() || 'unknown',
  }
}

export const isRunning = (status: ParsedStatus): boolean => status.state === 'running'

/** `fqdn` holds a comma-separated list; the dashboard shows the first domain. */
export function primaryFqdn(fqdn: string | null | undefined): string | null {
  const first = (fqdn ?? '')
    .split(',')
    .map(part => part.trim())
    .find(Boolean)
  return first ?? null
}

export function displayDomain(fqdn: string | null | undefined): string {
  const first = primaryFqdn(fqdn)
  if (!first) return 'internal · no public domain'
  return first.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export function initialOf(name: string): string {
  const letter = name.match(/[a-z0-9]/i)?.[0]
  return (letter ?? '?').toUpperCase()
}

const GRADIENTS = [
  'linear-gradient(135deg,#6366f1,#8b5cf6)',
  'linear-gradient(135deg,#0ea5e9,#22d3ee)',
  'linear-gradient(135deg,#f59e0b,#f97316)',
  'linear-gradient(135deg,#10b981,#3ecf8e)',
  'linear-gradient(135deg,#ec4899,#f43f5e)',
  'linear-gradient(135deg,#8b5cf6,#d946ef)',
] as const

/** Stable per app: the same uuid always gets the same tile colour. */
export function gradientFor(seed: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return GRADIENTS[hash % GRADIENTS.length] as string
}

export function mapApplication(
  app: Api.Application,
  autoDeploy: boolean | null,
  /** measured by the BFF's own HTTP probes (phase 4); `null` when not probed */
  uptime: string | null = null,
): Application {
  return {
    id: app.uuid,
    name: app.name,
    domain: displayDomain(app.fqdn),
    initial: initialOf(app.name),
    gradient: gradientFor(app.uuid),
    uptime,
    autoDeploy,
  }
}

/** What the BFF measures itself and the REST API does not carry (phases 4 & 5). */
export interface ServerReadings {
  /** TCP handshake time from the BFF to the server's SSH port */
  pingMs?: number | null
  /**
   * Percentage from the last `high_disk_usage` webhook. Only meaningful while
   * Coolify still considers the disk full — it stops sending readings once the
   * situation clears, so an old value outside that window would be a lie.
   */
  diskPct?: number | null
  /** Sentinel's own percentages, `null` unless `source` is `sentinel`. */
  cpu?: number | null
  mem?: number | null
  /** where cpu/mem came from, or which silence this is */
  source?: MetricsSource
  note?: string
}

export function mapServer(server: Api.Server, readings: ServerReadings = {}): Server {
  const diskAlert = server.high_disk_usage_notification_sent === true
  const source = readings.source ?? 'off'
  const measured = source === 'sentinel'
  return {
    id: server.uuid,
    name: server.name,
    // Coolify has no notion of region; the address is the honest stand-in.
    region: server.description?.trim() || server.ip || '—',
    pingMs: readings.pingMs ?? null,
    reachable: server.is_reachable ?? server.settings?.is_reachable ?? false,
    metrics: {
      // CPU and RAM come from Sentinel over SSH (docs/roadmap.md phase 5) or not at all:
      // a reading the collector could not take is never rounded up into a zero.
      cpu: measured ? (readings.cpu ?? null) : null,
      mem: measured ? (readings.mem ?? null) : null,
      // Disk is the one figure a webhook can supply, and only while the alert stands.
      dsk: diskAlert ? (readings.diskPct ?? null) : null,
      source,
      note: readings.note ?? 'No metrics source configured for this server.',
    },
  }
}

export function buildFleetTotals(servers: Server[], applicationCount: number): FleetTotals {
  const reachable = servers.filter(s => s.reachable).length
  // The fourth tile changes meaning with what is actually known. Hardware
  // totals (vCPU, RAM, storage) are not in the API at all — those wait for the
  // Hetzner inventory of phase 7 — but once Sentinel is being read, the mean
  // CPU load across the fleet is a real number, and it is labelled as one
  // rather than smuggled in under "Capacity".
  const loads = servers.map(server => server.metrics.cpu).filter((cpu): cpu is number => cpu !== null)
  const load =
    loads.length === 0
      ? { id: 'capacity', label: 'Capacity', value: '—' }
      : {
          id: 'load',
          label: loads.length === servers.length ? 'Avg load' : `Avg load (${loads.length}/${servers.length})`,
          value: `${Math.round(loads.reduce((total, cpu) => total + cpu, 0) / loads.length)}%`,
        }

  return [
    { id: 'servers', label: 'Servers', value: String(servers.length) },
    { id: 'reachable', label: 'Reachable', value: `${reachable}/${servers.length}` },
    { id: 'apps', label: 'Applications', value: String(applicationCount) },
    load,
  ]
}

/* -------------------------------------------------------- deployments ----- */

export function mapDeploymentState(status: string | null | undefined): DeploymentState {
  switch ((status ?? '').trim()) {
    case 'queued':
    case 'in_progress':
      return 'running'
    case 'finished':
      return 'success'
    case 'failed':
      return 'failed'
    case 'cancelled-by-user':
      return 'cancelled'
    default:
      // Unknown states are not silently called successes.
      return 'failed'
  }
}

/**
 * `logs` is a JSON **string** of `DeploymentLogLine[]` (already secret-redacted
 * upstream), only present for tokens with `read:sensitive` and an admin/owner
 * role. Hidden lines are build noise Coolify's own UI drops.
 */
export function parseDeploymentLogs(raw: string | null | undefined): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return (parsed as Api.DeploymentLogLine[])
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line && !line.hidden)
    .sort((a, b) => (a.line.order ?? a.index) - (b.line.order ?? b.index))
    .flatMap(({ line }) => {
      const output = (line.output ?? '').trim()
      if (output) return output.split('\n').map(text => `▸ ${text.trim()}`)
      const command = (line.command ?? '').trim()
      return command ? [`▸ ${command}`] : []
    })
    .filter(text => text.length > 2)
}

const shortSha = (commit: string | null | undefined): string => (commit ?? '').slice(0, 7)

export interface DeploymentContext {
  /** the deployment queue row does not carry the branch — it comes from the app */
  branch?: string | null
  appName?: string | null
}

export function mapDeployment(
  deployment: Api.ApplicationDeploymentQueue,
  context: DeploymentContext,
  now: number,
): Deployment {
  const state = mapDeploymentState(deployment.status)
  const createdAt = parseApiDate(deployment.created_at)
  const finishedAt = parseApiDate(deployment.finished_at)

  const base: Deployment = {
    id: deployment.deployment_uuid,
    app: context.appName ?? deployment.application_name ?? 'unknown',
    message: (deployment.commit_message ?? '').trim() || 'no commit message',
    branch: context.branch?.trim() || '—',
    sha: shortSha(deployment.commit) || '—',
    state,
  }

  if (state === 'running') {
    const logs = parseDeploymentLogs(deployment.logs)
    return {
      ...base,
      // There is no `started_at`: elapsed time includes any wait in the queue.
      elapsedSeconds: createdAt === null ? 0 : Math.max(0, Math.round((now - createdAt) / 1000)),
      ...(logs.length > 0 ? { logs } : {}),
    }
  }

  return {
    ...base,
    ...(createdAt !== null && finishedAt !== null
      ? { duration: formatDuration(finishedAt - createdAt) }
      : {}),
    ...(finishedAt !== null || createdAt !== null
      ? { when: formatRelative((finishedAt ?? createdAt) as number, now) }
      : {}),
  }
}

export interface DeploymentStats {
  total: number
  success: number
  failed: number
  successPct: number | null
  medianDurationMs: number | null
}

/** Aggregates a 24 h window from the per-application history. */
export function summarizeDeployments(
  deployments: Api.ApplicationDeploymentQueue[],
  now: number,
  windowMs = DAY_MS,
): DeploymentStats {
  const recent = deployments.filter(deployment => {
    const at = parseApiDate(deployment.finished_at) ?? parseApiDate(deployment.created_at)
    return at !== null && now - at <= windowMs && at <= now
  })

  const finished = recent.filter(d => mapDeploymentState(d.status) !== 'running')
  const success = finished.filter(d => mapDeploymentState(d.status) === 'success')
  const failed = finished.filter(d => mapDeploymentState(d.status) === 'failed')

  const durations = success
    .map(d => {
      const created = parseApiDate(d.created_at)
      const done = parseApiDate(d.finished_at)
      return created !== null && done !== null && done >= created ? done - created : null
    })
    .filter((value): value is number => value !== null)

  return {
    total: recent.length,
    success: success.length,
    failed: failed.length,
    successPct: finished.length > 0 ? (success.length / finished.length) * 100 : null,
    medianDurationMs: median(durations),
  }
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
}

/* ---------------------------------------------------------------- KPIs ---- */

/** Maps a series onto the 84×30 viewBox the KPI cards draw in. */
export function sparkFrom(values: number[], maxPoints = 12): Array<[number, number]> {
  const series = values.slice(-maxPoints)
  if (series.length < 2) {
    // A single reading is not a trend: draw it flat rather than inventing a slope.
    return [
      [0, 15],
      [84, 15],
    ]
  }

  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min

  return series.map((value, index) => {
    const x = Number(((index / (series.length - 1)) * 84).toFixed(1))
    // SVG y grows downward: the highest value must sit at the smallest y.
    const y = span === 0 ? 15 : Number((26 - ((value - min) / span) * 22).toFixed(1))
    return [x, y] as [number, number]
  })
}

export interface KpiSeries {
  applications: number[]
  deployments: number[]
  medianDeployMs: number[]
  backups: number[]
}

export interface KpiInput {
  applicationCount: number
  /** count from the snapshot closest to 7 days ago, null while history builds up */
  applicationsWeekAgo: number | null
  deployments: DeploymentStats
  /** median from the snapshot closest to 24 h ago */
  previousMedianDeployMs: number | null
  backups: { total: number; failed: number } | null
  series: KpiSeries
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function applicationsKpi(input: KpiInput): Kpi {
  const previous = input.applicationsWeekAgo
  const delta = previous === null ? null : input.applicationCount - previous

  let badge: Kpi['badge'] = { text: 'no history', trend: 'neutral' }
  let sub = 'collecting history'
  if (delta !== null) {
    if (delta > 0) {
      badge = { text: `+${delta}`, trend: 'ok', caret: true }
      sub = `${delta} added this week`
    } else if (delta < 0) {
      badge = { text: String(delta), trend: 'warn' }
      sub = `${-delta} removed this week`
    } else {
      badge = { text: 'stable', trend: 'neutral' }
      sub = 'no change this week'
    }
  }

  return {
    id: 'apps',
    icon: 'apps',
    label: 'Applications',
    badge,
    value: String(input.applicationCount),
    sub,
    spark: sparkFrom(input.series.applications),
  }
}

function deploymentsKpi(input: KpiInput): Kpi {
  const { total, successPct } = input.deployments

  let badge: Kpi['badge'] = { text: 'quiet', trend: 'neutral' }
  if (successPct !== null) {
    const rounded = Math.round(successPct)
    badge = {
      text: `${rounded} % ok`,
      trend: rounded >= 95 ? 'ok' : rounded >= 80 ? 'warn' : 'err',
    }
  }

  return {
    id: 'deployments',
    icon: 'deployments',
    label: 'Deployments',
    badge,
    value: String(total),
    sub: 'last 24 hours',
    spark: sparkFrom(input.series.deployments),
  }
}

function medianDeployKpi(input: KpiInput): Kpi {
  const current = input.deployments.medianDurationMs
  const spark = sparkFrom(input.series.medianDeployMs)

  if (current === null) {
    return {
      id: 'deploy-duration',
      icon: 'latency',
      label: 'Median deploy',
      badge: { text: 'no data', trend: 'neutral' },
      value: '—',
      sub: 'no deployment finished',
      spark,
    }
  }

  const useMinutes = current >= 600_000
  const previous = input.previousMedianDeployMs
  let badge: Kpi['badge'] = { text: 'first window', trend: 'neutral' }
  if (previous !== null && previous > 0) {
    const deltaSeconds = Math.round((current - previous) / 1000)
    badge =
      deltaSeconds === 0
        ? { text: 'stable', trend: 'neutral' }
        : {
            text: `${deltaSeconds > 0 ? '+' : '−'}${Math.abs(deltaSeconds)} s`,
            // slower is only worth flagging past 20 % drift
            trend: deltaSeconds < 0 ? 'ok' : current > previous * 1.2 ? 'warn' : 'neutral',
          }
  }

  return {
    id: 'deploy-duration',
    icon: 'latency',
    label: 'Median deploy',
    badge,
    value: useMinutes ? (current / 60_000).toFixed(1) : String(Math.round(current / 1000)),
    unit: useMinutes ? ' min' : ' s',
    sub: `over ${plural(input.deployments.success, 'deployment')}`,
    spark,
  }
}

function backupsKpi(input: KpiInput): Kpi {
  const spark = sparkFrom(input.series.backups)
  if (input.backups === null) {
    return {
      id: 'backups',
      icon: 'cost',
      label: 'Backups',
      badge: { text: 'no data', trend: 'neutral' },
      value: '—',
      sub: 'no database with a schedule',
      spark,
    }
  }

  const { total, failed } = input.backups
  return {
    id: 'backups',
    icon: 'cost',
    label: 'Backups',
    badge:
      failed > 0
        ? { text: `${failed} failed`, trend: 'err' }
        : { text: total > 0 ? 'all ok' : 'none due', trend: total > 0 ? 'ok' : 'neutral' },
    value: String(total),
    sub: 'in the last 24 hours',
    spark,
  }
}

/** KPI 3 and 4 replace the mockup's P95 and monthly cost, which have no source
    in Coolify core (see the mapping table in docs/roadmap.md, appendix C). */
export function buildKpis(input: KpiInput): Kpi[] {
  return [applicationsKpi(input), deploymentsKpi(input), medianDeployKpi(input), backupsKpi(input)]
}

/* ---------------------------------------------------------- scheduling ---- */

/** Coolify's own aliases (`bootstrap/helpers/constants.php`). */
const CRON_ALIASES: Record<string, string> = {
  every_minute: '* * * * *',
  hourly: '0 * * * *',
  daily: '0 0 * * *',
  weekly: '0 0 * * 0',
  monthly: '0 0 1 * *',
  yearly: '0 0 1 1 *',
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
}

export function normalizeFrequency(frequency: string): string {
  const trimmed = (frequency ?? '').trim()
  return CRON_ALIASES[trimmed] ?? trimmed
}

/**
 * Next run in the BFF's local timezone. Coolify evaluates crons in the
 * instance's timezone, so a BFF in another zone will place jobs on the
 * timeline with that offset.
 */
export function nextCronRun(frequency: string, from: number): number | null {
  const expression = normalizeFrequency(frequency)
  if (!expression) return null
  try {
    return CronExpressionParser.parse(expression, { currentDate: new Date(from) })
      .next()
      .getTime()
  } catch {
    return null
  }
}

export function describeFrequency(frequency: string): string {
  const expression = normalizeFrequency(frequency)
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.split(/\s+/)
  if (!minute || !hour) return expression || 'unknown schedule'

  const numeric = /^\d+$/
  const time =
    numeric.test(minute) && numeric.test(hour)
      ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
      : null

  let cadence = expression
  if (hour === '*') cadence = minute === '*' ? 'every minute' : 'every hour'
  else if (dayOfWeek && dayOfWeek !== '*') cadence = 'weekly'
  else if (dayOfMonth && dayOfMonth !== '*') cadence = 'monthly'
  else if (month && month !== '*') cadence = 'yearly'
  else if (dayOfMonth === '*' && dayOfWeek === '*') cadence = 'every day'

  return time ? `${time} · ${cadence}` : cadence
}

export interface TimelineJob {
  id: string
  title: string
  detail: string
  /** absolute timestamp of the next run */
  at: number
}

/** The strip covers `now → now + 24 h`; `now` sits at 2 % so its marker is not clipped. */
export function buildTimeline(now: number, jobs: TimelineJob[], maxJobs = 8): Timeline {
  const positionOf = (at: number) => Number((((at - now) / DAY_MS) * 100).toFixed(1))

  const firstTick = new Date(now)
  firstTick.setMinutes(0, 0, 0)
  firstTick.setHours(Math.floor(firstTick.getHours() / 6) * 6 + 6)

  const ticks = Array.from({ length: 4 }, (_, index) => {
    const at = firstTick.getTime() + index * 6 * 60 * 60_000
    return { left: positionOf(at), label: formatClock(at) }
  })

  const placed = jobs
    .filter(job => job.at > now && job.at <= now + DAY_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, maxJobs)
    .map(job => ({
      id: job.id,
      title: job.title,
      detail: job.detail,
      left: Math.min(99, Math.max(2, positionOf(job.at))),
    }))

  return {
    now: { left: 2, label: `now · ${formatClock(now)}` },
    ticks,
    jobs: placed,
  }
}

/* --------------------------------------------------------------- links --- */

/** Where a resource lives in Coolify's own URL space. */
export interface ResourceLocation {
  projectUuid: string
  environmentUuid: string
}

/**
 * Deep links back into Coolify's UI.
 *
 * An insight that only states a problem is half an insight — the button has to
 * land on the page where the problem gets fixed. Coolify's resource routes need
 * the project *and* the environment uuid on top of the resource's own
 * (`routes/web.php`), which the BFF already collects while resolving
 * environment names. Without that mapping the link falls back to the instance
 * root, which still beats a dead button.
 */
export interface CoolifyLinks {
  root(): string
  server(uuid: string): string
  application(uuid: string, environmentId: number | undefined, tab?: string): string
  database(uuid: string, environmentId: number | undefined, tab?: string): string
}

export function createLinks(baseUrl: string, locations: Map<number, ResourceLocation> = new Map()): CoolifyLinks {
  const base = baseUrl.replace(/\/+$/, '')

  const resource = (kind: 'application' | 'database', uuid: string, environmentId: number | undefined, tab?: string) => {
    const place = environmentId === undefined ? undefined : locations.get(environmentId)
    if (!place) return base
    const path = `${base}/project/${place.projectUuid}/environment/${place.environmentUuid}/${kind}/${uuid}`
    return tab ? `${path}/${tab}` : path
  }

  return {
    root: () => base,
    server: uuid => `${base}/server/${uuid}`,
    application: (uuid, environmentId, tab) => resource('application', uuid, environmentId, tab),
    database: (uuid, environmentId, tab) => resource('database', uuid, environmentId, tab),
  }
}

/* ------------------------------------------------------------ insights ---- */

export interface AppHealth {
  uuid: string
  name: string
  status: ParsedStatus
  /** for the deep link; the environment a resource belongs to */
  environmentId?: number
}

/** A server plus the things the mapped `Server` deliberately does not carry. */
export interface ServerHealth {
  server: Server
  /** Coolify has sent a `high_disk_usage` notification and not cleared it */
  diskAlert: boolean
  /** the figure from that webhook, when one reached the BFF */
  diskPct: number | null
  unreachableCount: number
  /**
   * The operator configured the Sentinel collector (phase 5), so an empty CPU
   * gauge is a fault worth reporting rather than the expected default.
   */
  metricsExpected: boolean
}

/** One application as seen from the outside, by the BFF's own probes. */
export interface ProbeHealth {
  uuid: string
  name: string
  host: string
  environmentId?: number
  /** `null` before the first probe */
  up: boolean | null
  consecutiveFailures: number
  /** `null` until enough samples to mean anything */
  uptimePct: number | null
  samples: number
  tls: { daysLeft: number | null; trusted: boolean; error: string | null } | null
}

export interface BackupFailure {
  database: string
  databaseUuid: string
  environmentId?: number
  at: number
}

export interface InsightInput {
  servers: ServerHealth[]
  applications: AppHealth[]
  /** empty when probing is disabled — every probe-based rule then stays quiet */
  probes: ProbeHealth[]
  /** failed deployments in the last 24 h, newest first */
  recentFailures: Array<{ app: string; at: number }>
  /** failed backup executions in the last 24 h */
  backupFailures: BackupFailure[]
  links: CoolifyLinks
  now: number
}

/** Consecutive failed probes before an application is called down (probes.ts). */
export const DOWN_AFTER_FAILURES = 3
/** A certificate closer than this to expiry is worth a warning. */
export const TLS_WARN_DAYS = 14
/** Below this, a day of probing was not a good day. */
export const UPTIME_TARGET_PCT = 99.5

const SEVERITY_RANK: Record<Insight['severity'], number> = { err: 0, warn: 1, neutral: 2, ok: 3 }

/**
 * The rules engine of phase 4. Every rule is a pure read of the state the BFF
 * already holds — REST payloads, its own probe results, the readings webhooks
 * carried — so the whole column is testable without a network.
 *
 * Rules push in order of how much they usually matter; the sort that follows is
 * stable, so within one severity that order is what the reader sees. Anything
 * past `limit` is not dropped silently: the last row says how many are hidden,
 * because a panel that shows five of nine problems while claiming "5" is worse
 * than no panel.
 */
export function buildInsights(input: InsightInput, limit = 5): Insight[] {
  const { links, now } = input
  const insights: Insight[] = []

  /* --- servers ------------------------------------------------------- */
  for (const { server, unreachableCount } of input.servers) {
    if (server.reachable) continue
    const attempts = unreachableCount > 1 ? ` Coolify has failed to reach it ${unreachableCount} times.` : ''
    insights.push({
      id: `server-unreachable-${server.id}`,
      severity: 'err',
      title: `${server.name} is unreachable`,
      description: `Coolify cannot open an SSH connection to ${server.region}.${attempts} Everything hosted there is unmanaged until it comes back.`,
      action: 'Open server',
      href: links.server(server.id),
    })
  }

  for (const { server, diskAlert, diskPct } of input.servers) {
    if (!diskAlert) continue
    const critical = diskPct !== null && diskPct >= 90
    insights.push({
      id: `server-disk-${server.id}`,
      severity: critical ? 'err' : 'warn',
      title: diskPct === null ? `${server.name} is low on disk space` : `${server.name} disk at ${Math.round(diskPct)} %`,
      description:
        'Coolify raised a high disk usage alert. Builds fail first, then containers stop writing — a Docker cleanup or a bigger volume buys the time back.',
      action: 'Open server',
      href: links.server(server.id),
    })
  }

  /**
   * Metrics the operator asked for and is not getting (phase 5). Silent by
   * design on a default install: with no collector configured, an empty gauge
   * is the documented state, not a problem. Once `METRICS_SSH_KEY` is set,
   * every empty gauge is a misconfiguration someone meant to avoid.
   */
  for (const { server, metricsExpected } of input.servers) {
    if (!metricsExpected) continue
    // An unreachable server already has an `err` row saying more than this would.
    if (!server.reachable || server.metrics.source === 'sentinel') continue
    const off = server.metrics.source === 'sentinel-off'
    insights.push({
      id: `metrics-${server.metrics.source}-${server.id}`,
      severity: 'warn',
      title: off ? `Sentinel metrics are off on ${server.name}` : `No metrics from ${server.name}`,
      description: server.metrics.note,
      action: 'Open server',
      href: links.server(server.id),
    })
  }

  /* --- applications, as Coolify sees them ----------------------------- */
  const brokenApps = new Set<string>()
  for (const app of input.applications) {
    if (isRunning(app.status) && app.status.health !== 'unhealthy') continue
    brokenApps.add(app.uuid)
    insights.push({
      id: `app-status-${app.uuid}`,
      severity: isRunning(app.status) ? 'warn' : 'err',
      title: isRunning(app.status) ? `${app.name} is unhealthy` : `${app.name} is ${app.status.state}`,
      description: isRunning(app.status)
        ? 'The container runs but its healthcheck keeps failing.'
        : `Container state reported by Coolify: ${app.status.state}:${app.status.health}.`,
      action: 'Open application',
      href: links.application(app.uuid, app.environmentId),
    })
  }

  /* --- applications, as the internet sees them ------------------------ */
  for (const probe of input.probes) {
    if (probe.consecutiveFailures < DOWN_AFTER_FAILURES) continue
    // Coolify already says the container is down: one problem, one insight.
    if (brokenApps.has(probe.uuid)) continue
    insights.push({
      id: `probe-down-${probe.uuid}`,
      severity: 'err',
      title: `${probe.name} is not answering`,
      description: `Coolify reports the container as running, but ${probe.host} has failed ${probe.consecutiveFailures} probes in a row from this dashboard. Suspect the proxy, DNS, or a healthy container serving errors.`,
      action: 'Open application',
      href: links.application(probe.uuid, probe.environmentId),
    })
  }

  /* --- certificates --------------------------------------------------- */
  for (const probe of input.probes) {
    const tls = probe.tls
    if (!tls) continue
    if (tls.daysLeft === null) {
      // Only worth saying when the handshake itself failed on the certificate;
      // a host that is simply down is already covered above.
      if (tls.error && probe.up) {
        insights.push({
          id: `tls-error-${probe.uuid}`,
          severity: 'warn',
          title: `${probe.name} has a certificate problem`,
          description: `The TLS handshake with ${probe.host} reported: ${tls.error}.`,
          action: 'Open domains',
          href: links.application(probe.uuid, probe.environmentId, 'domains'),
        })
      }
      continue
    }
    if (tls.daysLeft > TLS_WARN_DAYS) continue
    const expired = tls.daysLeft < 0
    insights.push({
      id: `tls-expiry-${probe.uuid}`,
      severity: expired || tls.daysLeft <= 3 ? 'err' : 'warn',
      title: expired
        ? `Certificate of ${probe.name} has expired`
        : `Certificate of ${probe.name} expires in ${tls.daysLeft} d`,
      description: expired
        ? `${probe.host} is serving a certificate that expired ${Math.abs(tls.daysLeft)} d ago — browsers are already refusing it.`
        : `${probe.host} renews automatically through Let's Encrypt; this close to expiry, the renewal is failing.`,
      action: 'Open domains',
      href: links.application(probe.uuid, probe.environmentId, 'domains'),
    })
  }

  /* --- backups -------------------------------------------------------- */
  for (const failure of input.backupFailures) {
    insights.push({
      id: `backup-failed-${failure.databaseUuid}`,
      severity: 'err',
      title: `Backup of ${failure.database} failed`,
      description: `The scheduled backup did not complete (${formatRelative(failure.at, now)}). Until it does, the recovery point is the last successful run.`,
      action: 'Open backups',
      href: links.database(failure.databaseUuid, failure.environmentId, 'backups'),
    })
  }

  /* --- deployments ---------------------------------------------------- */
  // Group repeated failures per app: three failed runs is one problem, not three.
  const failuresByApp = new Map<string, number>()
  for (const failure of input.recentFailures) {
    failuresByApp.set(failure.app, (failuresByApp.get(failure.app) ?? 0) + 1)
  }
  const appByName = new Map(input.applications.map(app => [app.name, app]))
  const deploymentLink = (name: string) => {
    const app = appByName.get(name)
    return app ? links.application(app.uuid, app.environmentId, 'deployment') : links.root()
  }

  for (const [app, count] of failuresByApp) {
    if (count < 2) continue
    insights.push({
      id: `deploy-failures-${app}`,
      severity: 'err',
      title: `${count} failed deployments on ${app}`,
      description: 'Every attempt in the last 24 hours ended in failure — the build or the healthcheck is broken, not flaky.',
      action: 'Open logs',
      href: deploymentLink(app),
    })
  }

  for (const [app, count] of failuresByApp) {
    if (count !== 1) continue
    insights.push({
      id: `deploy-failure-${app}`,
      severity: 'warn',
      title: `Last deployment of ${app} failed`,
      description: 'One failure in the last 24 hours. The previous release is still serving traffic.',
      action: 'Open logs',
      href: deploymentLink(app),
    })
  }

  /* --- uptime --------------------------------------------------------- */
  for (const probe of input.probes) {
    if (probe.uptimePct === null || probe.uptimePct >= UPTIME_TARGET_PCT) continue
    // An application that is down right now is already an insight of its own.
    if (probe.consecutiveFailures >= DOWN_AFTER_FAILURES || brokenApps.has(probe.uuid)) continue
    insights.push({
      id: `uptime-${probe.uuid}`,
      severity: 'warn',
      title: `${probe.name} answered ${probe.uptimePct.toFixed(2)} % of the time`,
      description: `Measured by this dashboard over the last 24 h, across ${probe.samples} probes of ${probe.host}. Short outages that resolve on their own usually mean a restart loop or a saturated proxy.`,
      action: 'Open application',
      href: links.application(probe.uuid, probe.environmentId),
    })
  }

  if (insights.length === 0) {
    return [
      {
        id: 'all-clear',
        severity: 'ok',
        title: 'Nothing needs your attention',
        description:
          'Every server is reachable, every application is running and no deployment failed in the last 24 hours.',
        action: 'View',
      },
    ]
  }

  insights.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

  if (insights.length <= limit) return insights

  const hidden = insights.length - (limit - 1)
  return [
    ...insights.slice(0, limit - 1),
    {
      id: 'more-insights',
      severity: insights[limit - 1]?.severity ?? 'warn',
      title: `${hidden} more issues need attention`,
      description: 'The panel shows the most serious ones first. The rest are in Coolify.',
      action: 'Open Coolify',
      href: links.root(),
    },
  ]
}

export function deriveSystemStatus(
  servers: Server[],
  failuresLastHour: number,
  /** applications the BFF's probes cannot reach — worse news than a failed build */
  downApplications: string[] = [],
): { ok: boolean; label: string } {
  const unreachable = servers.filter(server => !server.reachable)
  if (unreachable.length > 0) {
    return {
      ok: false,
      label: unreachable.length === 1
        ? `${unreachable[0]?.name} unreachable`
        : `${unreachable.length} servers unreachable`,
    }
  }
  if (downApplications.length > 0) {
    return {
      ok: false,
      label: downApplications.length === 1
        ? `${downApplications[0]} not answering`
        : `${downApplications.length} applications not answering`,
    }
  }
  if (failuresLastHour > 0) {
    return { ok: false, label: `${plural(failuresLastHour, 'failed deployment')} in the last hour` }
  }
  return { ok: true, label: 'All systems operational' }
}

/* ------------------------------------------------------------- palette ---- */

/** One executable task per palette entry — the SPA never parses an id. */
export interface TaskTarget {
  owner: 'application' | 'service'
  ownerId: string
  ownerName: string
  taskId: string
  taskName: string
}

/**
 * Every entry carries a `command` the SPA hands straight back to the BFF.
 * Stopping an application is the one destructive entry, so it asks twice.
 */
export function buildPaletteActions(
  applications: Application[],
  tasks: TaskTarget[] = [],
  limits: { apps?: number; tasks?: number } = {},
): PaletteAction[] {
  const { apps: maxApps = 4, tasks: maxTasks = 4 } = limits
  const actions: PaletteAction[] = []

  applications.slice(0, maxApps).forEach((app, index) => {
    actions.push({
      id: `deploy:${app.id}`,
      icon: 'rocket',
      title: `Deploy ${app.name}`,
      command: { kind: 'deploy', application: app.id },
      ...(index === 0 ? { shortcut: 'D' } : {}),
    })
    actions.push({
      id: `restart:${app.id}`,
      icon: 'rotate',
      title: `Restart ${app.name}`,
      command: { kind: 'restart', application: app.id },
    })
    actions.push({
      id: `stop:${app.id}`,
      icon: 'stop',
      title: `Stop ${app.name}`,
      command: { kind: 'stop', application: app.id },
      confirm: `Confirm — stop ${app.name}`,
    })
  })

  tasks.slice(0, maxTasks).forEach(task => {
    actions.push({
      id: `task:${task.owner}:${task.ownerId}:${task.taskId}`,
      icon: 'clock',
      title: `Run ${task.taskName} — ${task.ownerName}`,
      command: { kind: 'run-task', owner: task.owner, ownerId: task.ownerId, task: task.taskId },
    })
  })

  actions.push({
    id: 'switch-environment',
    icon: 'swap',
    title: 'Switch environment',
    shortcut: 'E',
    command: { kind: 'ui', target: 'switch-environment' },
  })
  return actions
}
