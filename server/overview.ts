/**
 * Turns ~10 Coolify endpoints into the single `Dashboard` payload the SPA reads.
 *
 * Every upstream family goes through the TTL cache, so the number of requests
 * the BFF makes is a function of *time*, not of how many browsers are watching
 * (annexe B of PLAN.md). A family that fails degrades into a `DegradedNote`
 * rather than taking the whole dashboard down — except applications and
 * servers, without which there is no dashboard to show.
 */

import type { DegradedNote, HealthResponse, OverviewResponse } from '../shared/bff'
import type { Dashboard } from '../shared/dashboard'
import type * as Api from '../shared/coolify-api'
import { TTL, type TtlCache } from './cache'
import type { KpiSample, SnapshotStore } from './store'
import { CoolifyError, type CoolifyClient } from './coolify/client'
import {
  DAY_MS,
  buildFleetTotals,
  buildInsights,
  buildKpis,
  buildPaletteActions,
  buildTimeline,
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
  now?: () => number
}

export interface OverviewService {
  build(requestedEnv: string | null): Promise<OverviewResponse>
  /** `live` is the route's to add — the aggregator knows nothing of the push channel. */
  health(): Promise<Omit<HealthResponse, 'live'>>
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

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

const nonNull = <T>(value: T | null | undefined): value is T => value != null

export function createOverviewService(deps: OverviewDeps): OverviewService {
  const { client, cache, store, historyTake } = deps
  const clock = deps.now ?? Date.now

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
    for (const list of environmentLists) {
      for (const environment of list) environmentNameById.set(environment.id, environment.name)
    }

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

    const mappedApplications = envApplications.map((app, index) =>
      mapApplication(app, details[index]?.settings?.is_auto_deploy_enabled ?? null),
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
    const { jobs, taskTargets, backups } = await collectSchedule({
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

    const mappedServers = servers.map(mapServer)

    const dashboard: Dashboard = {
      org: team?.name ?? 'Coolify',
      environment: activeEnvironment,
      environments: environmentNames.length > 0 ? environmentNames : [activeEnvironment],
      systemStatus: deriveSystemStatus(
        mappedServers,
        failures.filter(entry => now - entry.at <= HOUR_MS).length,
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
        servers: mappedServers,
        applications: envApplications.map(app => ({
          uuid: app.uuid,
          name: app.name,
          status: parseResourceStatus(app.status),
        })),
        recentFailures: failures.map(entry => ({ app: entry.app.name, at: entry.at })),
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
      notes: [...notes, ...STRUCTURAL_NOTES],
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
          if ((execution.status ?? '').toLowerCase().startsWith('fail')) failed++
        }
      }
    }

    return { jobs, taskTargets, backups: scheduled === 0 ? null : { total: executed, failed } }
  }

  async function health(): Promise<Omit<HealthResponse, 'live'>> {
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

/** Gaps that are structural in phase 1, not transient failures. */
const STRUCTURAL_NOTES: DegradedNote[] = [
  {
    scope: 'metrics',
    reason: 'Coolify has no REST endpoint for CPU/RAM/disk — those come from Sentinel over SSH (PLAN.md phase 5).',
  },
  { scope: 'uptime', reason: 'Coolify tracks no uptime; HTTP probes land in phase 4.' },
  { scope: 'traffic', reason: 'No edge traffic metrics in Coolify core (PLAN.md phase 7).' },
]

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
