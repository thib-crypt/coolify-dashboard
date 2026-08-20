/**
 * Turns ~10 Coolify endpoints into the single `Dashboard` payload the SPA reads.
 *
 * Every upstream family goes through the TTL cache, so the number of requests
 * the BFF makes is a function of *time*, not of how many browsers are watching
 * (appendix B of docs/roadmap.md). A family that fails degrades into a `DegradedNote`
 * rather than taking the whole dashboard down — except applications and
 * servers, without which there is no dashboard to show.
 */

import type { DegradedNote, HealthResponse, OverviewResponse } from '../shared/bff'
import type { Dashboard } from '../shared/dashboard'
import type * as Api from '../shared/coolify-api'
import { TTL, type TtlCache } from './cache'
import { mapLimit } from './concurrency'
import type { KpiSample, SnapshotStore } from './store'
import { CoolifyError, type CoolifyClient } from './coolify/client'
import { EMPTY_METRICS, degradedMetrics, type MetricsSnapshot } from './metrics'
import { EMPTY_SNAPSHOT, MIN_UPTIME_SAMPLES, formatUptime, type ProbeSnapshot } from './probes'
import type { SignalStore } from './signals'
import {
  DAY_MS,
  DOWN_AFTER_FAILURES,
  buildFleetTotals,
  buildInsights,
  buildKpis,
  buildPaletteActions,
  buildTimeline,
  createLinks,
  deriveSystemStatus,
  describeFrequency,
  mapApplication,
  mapDeployment,
  mapDeploymentState,
  mapServer,
  nextCronRun,
  parseApiDate,
  parseResourceStatus,
  summarizeDeployments,
  type BackupFailure,
  type ProbeHealth,
  type ResourceLocation,
  type ServerHealth,
  type TaskTarget,
  type TimelineJob,
} from './coolify/mappers'

const HOUR_MS = 60 * 60_000
const WEEK_MS = 7 * DAY_MS
const MAX_DEPLOYMENT_ROWS = 5
/** How many upstream calls may be in flight at once when fanning out per resource. */
const FAN_OUT = 4

export interface OverviewDeps {
  client: CoolifyClient
  cache: TtlCache
  store: SnapshotStore
  historyTake: number
  coolifyUrl: string
  /** current state of the outbound probes; omitted when probing is off */
  probes?: () => ProbeSnapshot
  /** current state of the Sentinel collector; omitted when it is not configured */
  metrics?: () => MetricsSnapshot
  /** readings only webhooks carry (disk usage) */
  signals?: SignalStore
  now?: () => number
}

export interface OverviewService {
  build(requestedEnv: string | null): Promise<OverviewResponse>
  /** `live`, `probes` and `metrics` are the route's to add — the aggregator owns none. */
  health(): Promise<Omit<HealthResponse, 'live' | 'probes' | 'metrics'>>
}

/** Message worth showing a human, out of whatever went wrong upstream. */
export function describeError(error: unknown): string {
  if (error instanceof CoolifyError) {
    switch (error.code) {
      case 'unauthorized':
        return 'Coolify rejected the token — check COOLIFY_TOKEN.'
      case 'forbidden':
        return `Token lacks the required permission: ${error.message}`
      case 'api_disabled':
        return 'The Coolify API is disabled (Settings → Advanced → API Access).'
      case 'ip_blocked':
        return 'This host is not in Coolify\'s API allowlist (Settings → Advanced).'
      case 'rate_limited':
        return 'Coolify rate limit reached.'
      // Coolify's own sentence is the useful one for these — no status noise.
      case 'queue_full':
      case 'bad_request':
      case 'not_found':
        return error.message
      case 'unreachable':
        return error.message
      default:
        return `${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`
    }
  }
  return error instanceof Error ? error.message : String(error)
}

const nonNull = <T>(value: T | null | undefined): value is T => value != null

export function createOverviewService(deps: OverviewDeps): OverviewService {
  const { client, cache, store, historyTake } = deps
  const clock = deps.now ?? Date.now
  const probeState = deps.probes ?? (() => EMPTY_SNAPSHOT)
  const metricsState = deps.metrics ?? (() => EMPTY_METRICS)

  /** Cached read that degrades to `fallback` and records why. */
  async function optional<T>(
    key: string,
    scope: string,
    ttl: number,
    loader: () => Promise<T>,
    fallback: T,
    notes: DegradedNote[],
  ): Promise<T> {
    try {
      const result = await cache.fetch(key, ttl, loader)
      if (!result.fresh) {
        notes.push({ scope, reason: `${describeError(result.error)} Showing the last known value.` })
      }
      return result.value
    } catch (error) {
      notes.push({ scope, reason: describeError(error) })
      return fallback
    }
  }

  /** Cached read the dashboard cannot do without. */
  async function required<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
    return (await cache.fetch(key, ttl, loader)).value
  }

  async function build(requestedEnv: string | null): Promise<OverviewResponse> {
    const now = clock()
    const notes: DegradedNote[] = []

    const [team, projects, applications, servers] = await Promise.all([
      optional('team', 'team', TTL.team, () => client.team(), null as Api.Team | null, notes),
      optional('projects', 'environments', TTL.projects, () => client.projects(), [] as Api.Project[], notes),
      required('applications', TTL.applications, () => client.applications()),
      required('servers', TTL.servers, () => client.servers()),
    ])

    /* --- environments: only `/projects/{uuid}/environments` maps id → name --- */
    const environmentLists = await mapLimit(projects, FAN_OUT, project =>
      optional(
        `environments:${project.uuid}`,
        'environments',
        TTL.environments,
        () => client.environments(project.uuid),
        [] as Api.Environment[],
        notes,
      ),
    )
    const environmentNameById = new Map<number, string>()
    // Same loop feeds the deep links: a Coolify resource URL needs the project
    // uuid *and* the environment uuid, and this is the only place both are known.
    const locationByEnvironmentId = new Map<number, ResourceLocation>()
    environmentLists.forEach((list, index) => {
      const projectUuid = projects[index]?.uuid
      for (const environment of list) {
        environmentNameById.set(environment.id, environment.name)
        if (projectUuid) locationByEnvironmentId.set(environment.id, { projectUuid, environmentUuid: environment.uuid })
      }
    })
    const links = createLinks(deps.coolifyUrl, locationByEnvironmentId)

    const canFilterByEnvironment = environmentNameById.size > 0
    if (!canFilterByEnvironment) {
      notes.push({
        scope: 'environments',
        reason: 'Could not read the project environments — showing every resource of the team.',
      })
    }

    const environmentOf = (id: number | undefined): string | null =>
      id === undefined ? null : (environmentNameById.get(id) ?? null)

    const environmentNames = [...new Set(environmentNameById.values())].sort()
    const activeEnvironment = pickEnvironment(requestedEnv, environmentNames, applications, environmentOf)

    const inEnvironment = <T extends { environment_id?: number }>(items: T[]): T[] =>
      canFilterByEnvironment ? items.filter(item => environmentOf(item.environment_id) === activeEnvironment) : items

    const envApplications = inEnvironment(applications)

    /* --- per-application detail: the list endpoint carries no `settings` --- */
    let detailFailures = 0
    const details = await mapLimit(envApplications, FAN_OUT, async app => {
      try {
        return await required(`application:${app.uuid}`, TTL.applicationDetail, () => client.application(app.uuid))
      } catch {
        detailFailures++
        return null
      }
    })
    if (detailFailures > 0) {
      notes.push({
        scope: 'applications',
        reason: `Could not read settings for ${detailFailures} application(s) — auto-deploy state is unknown for those.`,
      })
    }

    /* --- what the BFF measured itself, from outside Coolify (phase 4) ---- */
    const probes = probeState()
    const uptimeOf = (uuid: string): string | null => {
      const probe = probes.applications.get(uuid)
      return probe?.uptimePct == null ? null : formatUptime(probe.uptimePct)
    }

    const mappedApplications = envApplications.map((app, index) =>
      mapApplication(app, details[index]?.settings?.is_auto_deploy_enabled ?? null, uptimeOf(app.uuid)),
    )

    /* --- deployments: `/deployments` is live-only, history is per application --- */
    let historyFailures = 0
    const histories = await mapLimit(envApplications, FAN_OUT, async app => {
      try {
        const page = await required(`deployments:${app.uuid}`, TTL.deploymentHistory, () =>
          client.applicationDeployments(app.uuid, historyTake),
        )
        return { app, deployments: Array.isArray(page?.deployments) ? page.deployments : [] }
      } catch {
        historyFailures++
        return { app, deployments: [] as Api.ApplicationDeploymentQueue[] }
      }
    })
    if (historyFailures > 0) {
      notes.push({
        scope: 'deployments',
        reason: `Could not read the deployment history of ${historyFailures} application(s) — KPIs cover the rest.`,
      })
    }

    const stats = summarizeDeployments(histories.flatMap(entry => entry.deployments), now)

    const finished = histories
      .flatMap(({ app, deployments }) =>
        deployments
          .filter(deployment => mapDeploymentState(deployment.status) !== 'running')
          .map(deployment => ({
            deployment,
            app,
            at: parseApiDate(deployment.finished_at) ?? parseApiDate(deployment.created_at) ?? 0,
          })),
      )
      .sort((a, b) => b.at - a.at)

    const failures = finished.filter(
      entry => mapDeploymentState(entry.deployment.status) === 'failed' && now - entry.at <= DAY_MS,
    )

    const running = await optional(
      'deployments:running',
      'deployments',
      TTL.deployments,
      () => client.runningDeployments(),
      [] as Api.ApplicationDeploymentQueue[],
      notes,
    )
    // The queue row has no application uuid, only `application_name` — that name
    // is the sole join back to the applications of this environment.
    const applicationByName = new Map(envApplications.map(app => [app.name, app]))
    const runningHere = running.filter(deployment => applicationByName.has(deployment.application_name ?? ''))

    const deployments = [
      ...runningHere.map(deployment => {
        const app = applicationByName.get(deployment.application_name ?? '')
        return mapDeployment(deployment, { branch: app?.git_branch, appName: app?.name }, now)
      }),
      ...finished
        .slice(0, Math.max(0, MAX_DEPLOYMENT_ROWS - runningHere.length))
        .map(entry => mapDeployment(entry.deployment, { branch: entry.app.git_branch, appName: entry.app.name }, now)),
    ]

    /* --- schedule: scheduled tasks + database backups, placed by cron --- */
    const { jobs, taskTargets, backups, backupFailures } = await collectSchedule({
      applications: envApplications,
      inEnvironment,
      now,
      notes,
    })

    /* --- history-backed KPIs -------------------------------------------- */
    const sample: KpiSample = {
      applications: envApplications.length,
      deployments24h: stats.total,
      deploySuccessPct: stats.successPct,
      medianDeployMs: stats.medianDurationMs,
      backups24h: backups?.total ?? null,
    }
    store.record(activeEnvironment, sample, now)

    const snapshots = store.history(activeEnvironment, 12)
    const series = {
      applications: withCurrent(snapshots.map(row => row.applications), sample.applications, snapshots, now),
      deployments: withCurrent(snapshots.map(row => row.deployments24h), sample.deployments24h, snapshots, now),
      medianDeployMs: snapshots.map(row => row.medianDeployMs).filter(nonNull),
      backups: snapshots.map(row => row.backups24h).filter(nonNull),
    }

    /* --- CPU and RAM: Sentinel over SSH, or an explained em dash (phase 5) --- */
    const metrics = metricsState()
    const readingFor = (server: Api.Server) => {
      const reading = metrics.servers.get(server.uuid)
      if (reading) return { cpu: reading.cpu, mem: reading.mem, source: reading.source, note: reading.note }
      // No reading at all: either nothing collects them here, or the collector
      // has not reached this server yet. Both deserve their own sentence.
      return degradedMetrics({
        collector: metrics.enabled,
        metricsEnabled: server.settings?.is_metrics_enabled === true,
        reachable: server.is_reachable ?? server.settings?.is_reachable ?? false,
      })
    }

    const mappedServers = servers.map(server =>
      mapServer(server, {
        pingMs: probes.servers.get(server.uuid)?.latencyMs ?? null,
        diskPct: deps.signals?.latest('disk_usage', server.name, now)?.value ?? null,
        ...readingFor(server),
      }),
    )

    const serverHealth: ServerHealth[] = servers.map((server, index) => ({
      server: mappedServers[index] as (typeof mappedServers)[number],
      diskAlert: server.high_disk_usage_notification_sent === true,
      diskPct: deps.signals?.latest('disk_usage', server.name, now)?.value ?? null,
      unreachableCount: server.unreachable_count ?? 0,
      metricsExpected: metrics.enabled,
    }))

    // Probes are keyed by application uuid and know nothing of environments;
    // the filter here is what keeps an insight about staging out of production.
    const probeHealth: ProbeHealth[] = envApplications
      .map(app => {
        const probe = probes.applications.get(app.uuid)
        if (!probe) return null
        return {
          uuid: app.uuid,
          name: app.name,
          host: probe.host,
          ...(app.environment_id === undefined ? {} : { environmentId: app.environment_id }),
          up: probe.up,
          consecutiveFailures: probe.consecutiveFailures,
          uptimePct: probe.uptimePct,
          samples: probe.samples,
          tls: probe.tls
            ? { daysLeft: probe.tls.daysLeft, trusted: probe.tls.trusted, error: probe.tls.error }
            : null,
        } satisfies ProbeHealth
      })
      .filter(nonNull)

    const downApplications = probeHealth
      .filter(probe => probe.consecutiveFailures >= DOWN_AFTER_FAILURES)
      .map(probe => probe.name)

    const dashboard: Dashboard = {
      org: team?.name ?? 'Coolify',
      environment: activeEnvironment,
      environments: environmentNames.length > 0 ? environmentNames : [activeEnvironment],
      systemStatus: deriveSystemStatus(
        mappedServers,
        failures.filter(entry => now - entry.at <= HOUR_MS).length,
        downApplications,
      ),
      kpis: buildKpis({
        applicationCount: envApplications.length,
        applicationsWeekAgo: store.before(activeEnvironment, now - WEEK_MS)?.applications ?? null,
        deployments: stats,
        previousMedianDeployMs: store.before(activeEnvironment, now - DAY_MS)?.medianDeployMs ?? null,
        backups,
        series,
      }),
      deployments,
      deploymentCount: stats.total,
      servers: mappedServers,
      fleetTotals: buildFleetTotals(mappedServers, envApplications.length),
      insights: buildInsights({
        servers: serverHealth,
        applications: envApplications.map(app => ({
          uuid: app.uuid,
          name: app.name,
          status: parseResourceStatus(app.status),
          ...(app.environment_id === undefined ? {} : { environmentId: app.environment_id }),
        })),
        probes: probeHealth,
        recentFailures: failures.map(entry => ({ app: entry.app.name, at: entry.at })),
        backupFailures,
        links,
        now,
      }),
      applications: mappedApplications,
      applicationCount: envApplications.length,
      timeline: buildTimeline(now, jobs),
      paletteActions: buildPaletteActions(mappedApplications, taskTargets),
    }

    return {
      generatedAt: new Date(now).toISOString(),
      staleAfterMs: TTL.deployments,
      dashboard,
      notes: [
        ...notes,
        ...probeNotes(probes, envApplications.length),
        ...metricsNotes(metrics, mappedServers.length),
        ...STRUCTURAL_NOTES,
      ],
    }
  }

  /** Scheduled tasks and database backups, both for the timeline and for KPI 4. */
  async function collectSchedule(input: {
    applications: Api.Application[]
    inEnvironment: <T extends { environment_id?: number }>(items: T[]) => T[]
    now: number
    notes: DegradedNote[]
  }): Promise<{
    jobs: TimelineJob[]
    /** enabled tasks the palette can run on demand */
    taskTargets: TaskTarget[]
    backups: { total: number; failed: number } | null
    /** newest failed execution per database, last 24 h — one insight each */
    backupFailures: BackupFailure[]
  }> {
    const { applications, inEnvironment, now, notes } = input
    const jobs: TimelineJob[] = []
    const taskTargets: TaskTarget[] = []

    const pushTask = (task: Api.ScheduledTask, owner: string) => {
      if (task.enabled === false || !task.frequency) return
      const at = nextCronRun(task.frequency, now)
      if (at === null) return
      jobs.push({
        id: `task-${task.uuid}`,
        title: `${task.name} — ${owner}`,
        detail: `${describeFrequency(task.frequency)}${task.container ? ` · ${task.container}` : ''}`,
        at,
      })
    }

    const applicationTasks = await mapLimit(applications, FAN_OUT, app =>
      optional(
        `tasks:application:${app.uuid}`,
        'schedule',
        TTL.scheduledTasks,
        () => client.applicationScheduledTasks(app.uuid),
        [] as Api.ScheduledTask[],
        notes,
      ),
    )
    applicationTasks.forEach((tasks, index) => {
      const application = applications[index]
      const owner = application?.name ?? 'application'
      for (const task of tasks) {
        pushTask(task, owner)
        // A task with no cron never shows on the timeline but can still be run by hand.
        if (task.enabled !== false && application) {
          taskTargets.push({
            owner: 'application',
            ownerId: application.uuid,
            ownerName: owner,
            taskId: task.uuid,
            taskName: task.name,
          })
        }
      }
    })

    const services = inEnvironment(
      await optional('services', 'schedule', TTL.scheduledTasks, () => client.services(), [] as Api.Service[], notes),
    )
    const serviceTasks = await mapLimit(services, FAN_OUT, service =>
      optional(
        `tasks:service:${service.uuid}`,
        'schedule',
        TTL.scheduledTasks,
        () => client.serviceScheduledTasks(service.uuid),
        [] as Api.ScheduledTask[],
        notes,
      ),
    )
    serviceTasks.forEach((tasks, index) => {
      const service = services[index]
      const owner = service?.name ?? 'service'
      for (const task of tasks) {
        pushTask(task, owner)
        if (task.enabled !== false && service) {
          taskTargets.push({
            owner: 'service',
            ownerId: service.uuid,
            ownerName: owner,
            taskId: task.uuid,
            taskName: task.name,
          })
        }
      }
    })

    /* --- database backups ------------------------------------------------ */
    const databases = inEnvironment(
      await optional('databases', 'backups', TTL.databases, () => client.databases(), [] as Api.Database[], notes),
    )
    const backupConfigs = await mapLimit(databases, FAN_OUT, async database => ({
      database,
      configs: await optional(
        `backups:${database.uuid}`,
        'backups',
        TTL.databases,
        () => client.databaseBackups(database.uuid),
        [] as Api.ScheduledDatabaseBackup[],
        notes,
      ),
    }))

    let scheduled = 0
    let executed = 0
    let failed = 0
    const failureByDatabase = new Map<string, BackupFailure>()

    for (const { database, configs } of backupConfigs) {
      for (const config of configs) {
        scheduled++
        if (config.enabled !== false && config.frequency) {
          const at = nextCronRun(config.frequency, now)
          if (at !== null) {
            jobs.push({
              id: `backup-${config.uuid}`,
              title: `Database backup — ${database.name}`,
              detail: `${describeFrequency(config.frequency)}${config.save_s3 ? ' · → S3' : ' · local'}`,
              at,
            })
          }
        }
        for (const execution of config.executions ?? []) {
          const at = parseApiDate(execution.finished_at) ?? parseApiDate(execution.created_at)
          if (at === null || now - at > DAY_MS) continue
          executed++
          if (!(execution.status ?? '').toLowerCase().startsWith('fail')) continue
          failed++
          // Five failed runs of the same nightly backup is one broken backup.
          const previous = failureByDatabase.get(database.uuid)
          if (!previous || at > previous.at) {
            failureByDatabase.set(database.uuid, {
              database: database.name,
              databaseUuid: database.uuid,
              ...(database.environment_id === undefined ? {} : { environmentId: database.environment_id }),
              at,
            })
          }
        }
      }
    }

    return {
      jobs,
      taskTargets,
      backups: scheduled === 0 ? null : { total: executed, failed },
      backupFailures: [...failureByDatabase.values()].sort((a, b) => b.at - a.at),
    }
  }

  async function health(): Promise<Omit<HealthResponse, 'live' | 'probes' | 'metrics'>> {
    const notes: DegradedNote[] = []
    const version = await optional('version', 'coolify', TTL.version, () => client.version(), null, notes)
    return {
      ok: version !== null,
      service: 'coolify-dashboard-bff',
      now: new Date(clock()).toISOString(),
      coolify: { configured: true, url: deps.coolifyUrl, version: version?.trim() ?? null },
      notes,
    }
  }

  return { build, health }
}

/** Gaps that are structural, not transient failures. */
const STRUCTURAL_NOTES: DegradedNote[] = [
  { scope: 'traffic', reason: 'No edge traffic metrics in Coolify core — Traefik metrics are on the roadmap.' },
]

/**
 * What the CPU and memory gauges are not saying, and why.
 *
 * The first branch is the one almost every install sees: Coolify has no REST
 * endpoint for either figure, so without an SSH key the dashboard has no way to
 * read them. That is worth stating plainly rather than leaving three empty bars
 * to be read as "idle".
 */
export function metricsNotes(metrics: MetricsSnapshot, serverCount: number): DegradedNote[] {
  if (!metrics.enabled) {
    return [
      {
        scope: 'metrics',
        reason:
          'Coolify has no REST endpoint for CPU or RAM — its own charts read them from the Sentinel agent over SSH. Set METRICS_SSH_KEY to let this dashboard do the same.',
      },
    ]
  }

  if (serverCount === 0) return []

  const readings = [...metrics.servers.values()]
  const silent = readings.filter(reading => reading.source !== 'sentinel')
  // Nothing collected yet at all: the first cycle has not landed.
  if (readings.length === 0) {
    return [{ scope: 'metrics', reason: 'The Sentinel collector has not completed its first cycle yet.' }]
  }
  if (silent.length === 0) return []

  return [
    {
      scope: 'metrics',
      reason:
        silent.length === 1 && silent[0]
          ? silent[0].note
          : `${silent.length} of ${readings.length} servers are not reporting metrics — hover their gauges for the reason.`,
    },
  ]
}

/**
 * What the uptime column is not saying, and why. Three different silences —
 * probing turned off, nothing to probe, not enough samples yet — that would
 * otherwise all look like the same em dash.
 */
export function probeNotes(probes: ProbeSnapshot, applicationCount: number): DegradedNote[] {
  if (!probes.enabled) {
    return [
      {
        scope: 'uptime',
        reason:
          'HTTP probes are off (PROBES_ENABLED=false), so uptime, latency and certificate expiry are not measured. Coolify itself tracks none of them.',
      },
    ]
  }

  if (probes.applications.size === 0) {
    return applicationCount === 0
      ? []
      : [{ scope: 'uptime', reason: 'No application in this environment has a public domain to probe.' }]
  }

  const warming = [...probes.applications.values()].filter(probe => probe.samples < MIN_UPTIME_SAMPLES)
  if (warming.length === 0) return []
  return [
    {
      scope: 'uptime',
      reason: `Still measuring ${warming.length} application(s) — a percentage needs at least ${MIN_UPTIME_SAMPLES} probes behind it.`,
    },
  ]
}

/** Prefers the requested environment, then the busiest one — usually production. */
export function pickEnvironment(
  requested: string | null,
  names: string[],
  applications: Api.Application[],
  environmentOf: (id: number | undefined) => string | null,
): string {
  if (requested && names.includes(requested)) return requested
  if (names.length === 0) return requested ?? 'all resources'

  const counts = new Map<string, number>()
  for (const app of applications) {
    const name = environmentOf(app.environment_id)
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  return [...names].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))[0] as string
}

/** Snapshots are hourly; the sparkline should still end on the value on screen. */
function withCurrent(
  series: number[],
  current: number,
  snapshots: Array<{ takenAt: number }>,
  now: number,
): number[] {
  const last = snapshots.at(-1)
  if (last && now - last.takenAt < 60_000) return series
  return [...series, current]
}
