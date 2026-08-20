/**
 * Turns ~10 Coolify endpoints into the single `Dashboard` payload the SPA reads.
 *
 * Every upstream family goes through the TTL cache, so the number of requests
 * the BFF makes is a function of *time*, not of how many browsers are watching
 * (appendix B of docs/roadmap.md). A family that fails degrades into a `DegradedNote`
 * rather than taking the whole dashboard down — except applications and
 * servers, without which there is no dashboard to show.
 */

import type {
  AppEnvVar,
  ApplicationDetailResponse,
  ApplicationLogsResponse,
  DegradedNote,
  DeploymentHistoryResponse,
  HealthResponse,
  OverviewResponse,
  RollbackTarget,
} from '../shared/bff'
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
  bareDomain,
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

export interface HistoryQuery {
  env: string | null
  skip: number
  take: number
  /** one application's history rather than the environment's, by uuid */
  application?: string | undefined
}

export interface OverviewService {
  build(requestedEnv: string | null): Promise<OverviewResponse>
  /**
   * The full deployment history of an environment, or of one application.
   * Reads through the same cache keys as `build`, so opening the page costs
   * nothing upstream while the overview's entries are still warm.
   */
  history(query: HistoryQuery): Promise<DeploymentHistoryResponse>
  /** One application, with what only its own page needs: envs and rollback targets. */
  detail(uuid: string): Promise<ApplicationDetailResponse>
  /** Runtime container logs. A stopped container is a state, not an error. */
  logs(uuid: string, lines: number): Promise<ApplicationLogsResponse>
  /** `live`, `probes` and `metrics` are the route's to add — the aggregator owns none. */
  health(): Promise<Omit<HealthResponse, 'auth' | 'live' | 'probes' | 'metrics'>>
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

  /**
   * The part every page-level read needs before it can say anything: who the
   * team is, which environments exist, which one is selected, and what belongs
   * to it. Extracted because the deployment history needs exactly this and
   * nothing else — and, going through the same cache keys, needs no upstream
   * request of its own once the overview has been built.
   */
  async function resolveScope(requestedEnv: string | null, notes: DegradedNote[]) {
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

    return {
      team,
      servers,
      applications,
      envApplications,
      activeEnvironment,
      environmentNames,
      links,
      environmentOf,
      inEnvironment,
      canFilterByEnvironment,
    }
  }

  async function build(requestedEnv: string | null): Promise<OverviewResponse> {
    const now = clock()
    const notes: DegradedNote[] = []

    const {
      team,
      servers,
      envApplications,
      activeEnvironment,
      environmentNames,
      links,
      inEnvironment,
    } = await resolveScope(requestedEnv, notes)

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

  // `auth` is added by the route, which is the only place that can see the
  // request's cookie; everything else here is a property of the process.
  async function health(): Promise<Omit<HealthResponse, 'auth' | 'live' | 'probes' | 'metrics'>> {
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

  /**
   * `/deployments` upstream returns only what is queued or running, so history
   * is per application and has to be gathered and re-sorted here. Coolify pages
   * each application separately (`skip`/`take`); this pulls `historyTake` from
   * each and pages the merged result, which is why `total` is "known here", not
   * "exists upstream".
   */
  async function history(query: HistoryQuery): Promise<DeploymentHistoryResponse> {
    const now = clock()
    const notes: DegradedNote[] = []
    const { envApplications, activeEnvironment } = await resolveScope(query.env, notes)

    const wanted = query.application
      ? envApplications.filter(app => app.uuid === query.application)
      : envApplications

    if (query.application && wanted.length === 0) {
      notes.push({
        scope: 'deployments',
        reason: 'That application is not in this environment — showing nothing rather than another one\'s history.',
      })
    }

    let failures = 0
    const histories = await mapLimit(wanted, FAN_OUT, async app => {
      try {
        const page = await required(`deployments:${app.uuid}`, TTL.deploymentHistory, () =>
          client.applicationDeployments(app.uuid, historyTake),
        )
        return { app, deployments: Array.isArray(page?.deployments) ? page.deployments : [] }
      } catch {
        failures++
        return { app, deployments: [] as Api.ApplicationDeploymentQueue[] }
      }
    })
    if (failures > 0) {
      notes.push({
        scope: 'deployments',
        reason: `Could not read the deployment history of ${failures} application(s).`,
      })
    }

    const rows = histories
      .flatMap(({ app, deployments }) =>
        deployments.map(deployment => ({
          deployment,
          app,
          at: parseApiDate(deployment.finished_at) ?? parseApiDate(deployment.created_at) ?? 0,
        })),
      )
      .sort((a, b) => b.at - a.at)

    const skip = Math.max(0, query.skip)
    const take = Math.min(Math.max(1, query.take), 200)

    return {
      generatedAt: new Date(now).toISOString(),
      environment: activeEnvironment,
      total: rows.length,
      skip,
      take,
      deployments: rows
        .slice(skip, skip + take)
        .map(entry =>
          mapDeployment(entry.deployment, { branch: entry.app.git_branch, appName: entry.app.name }, now),
        ),
      notes: [
        ...notes,
        // `historyTake` per application is the ceiling on what this can ever see.
        {
          scope: 'deployments',
          reason: `Built from the last ${historyTake} deployments of each application (DEPLOYMENT_HISTORY_TAKE).`,
        },
      ],
    }
  }

  /**
   * Everything about one application that the overview has no room for.
   *
   * The three optional reads degrade independently: environment variables need
   * `read` and give up their *values* only with `read:sensitive`, and the
   * rollback list shells into the server, so an unreachable one answers 200 with
   * an empty list. None of that should stop the page from rendering the
   * application it is about.
   */
  async function detail(uuid: string): Promise<ApplicationDetailResponse> {
    const now = clock()
    const notes: DegradedNote[] = []
    const { servers, links, environmentOf } = await resolveScope(null, notes)

    // Through the same cache key the overview fills, so opening this page while
    // the dashboard is warm costs nothing upstream.
    const app = await required(`application:${uuid}`, TTL.applicationDetail, () => client.application(uuid))

    const [envs, rollback] = await Promise.all([
      optional(
        `envs:${uuid}`,
        'envs',
        TTL.applicationDetail,
        () => client.applicationEnvs(uuid),
        [] as Api.EnvironmentVariable[],
        notes,
      ),
      optional(
        `rollback:${uuid}`,
        'rollback',
        TTL.applicationDetail,
        () => client.rollbackImages(uuid),
        {} as Api.RollbackImagesResponse,
        notes,
      ),
    ])

    const mappedEnvs: AppEnvVar[] = envs.map(env => ({
      key: env.key,
      // Absent, not empty: Coolify omits the field entirely rather than
      // redacting it, so `null` here means "not allowed to see" — and the UI
      // must not render it as an empty string.
      value: env.value ?? null,
      writeOnly: env.is_shown_once === true,
      buildTime: env.is_buildtime === true,
      preview: env.is_preview === true,
    }))

    if (mappedEnvs.length > 0 && mappedEnvs.every(env => env.value === null && !env.writeOnly)) {
      notes.push({
        scope: 'envs',
        reason: 'Coolify withheld every value — that needs a token with `read:sensitive`, owned by an admin or owner.',
      })
    }

    const targets: RollbackTarget[] = (rollback.images ?? [])
      .filter((image): image is Api.RollbackImage & { tag: string } => typeof image.tag === 'string' && image.tag !== '')
      .map(image => ({
        tag: image.tag,
        createdAt: image.created_at ?? null,
        current: image.is_current === true,
      }))

    if (targets.length === 0) {
      notes.push({
        scope: 'rollback',
        reason:
          'No image to roll back to. Coolify reads this with `docker images` over SSH, so an unreachable server also answers an empty list.',
      })
    }

    const probes = probeState()
    const probe = probes.applications.get(uuid)
    const status = parseResourceStatus(app.status)
    // `server_id` is the only link back; the applications list carries no server.
    const server = servers.find(entry => entry.id !== undefined && entry.id === app.server_id)

    return {
      generatedAt: new Date(now).toISOString(),
      uuid: app.uuid,
      name: app.name,
      description: app.description ?? null,
      domain: bareDomain(app.fqdn) ?? '',
      status: { state: status.state, health: status.health === 'unknown' ? null : status.health },
      repository: app.git_repository ?? null,
      branch: app.git_branch ?? null,
      buildPack: app.build_pack ?? null,
      autoDeploy: app.settings?.is_auto_deploy_enabled ?? null,
      uptime: probe?.uptimePct == null ? null : formatUptime(probe.uptimePct),
      link: links.application(app.uuid, app.environment_id),
      environment: environmentOf(app.environment_id),
      serverName: server?.name ?? null,
      envs: mappedEnvs,
      rollback: { current: rollback.current ?? null, targets },
      notes,
    }
  }

  /**
   * `GET /applications/{uuid}/logs` answers **400 "Application is not running."**
   * whenever the container is stopped. That is the ordinary state of a stopped
   * application, not a failure, so it becomes an empty list with a sentence —
   * the page says why it is empty instead of showing an error.
   */
  async function logs(uuid: string, lines: number): Promise<ApplicationLogsResponse> {
    try {
      const answer = await client.applicationLogs(uuid, Math.min(Math.max(1, lines), 500))
      const text = typeof answer.logs === 'string' ? answer.logs : ''
      const split = text.split(/\r?\n/).filter(line => line.length > 0)
      return split.length > 0
        ? { lines: split, note: null }
        : { lines: [], note: 'The container is running but has written nothing yet.' }
    } catch (error) {
      if (error instanceof CoolifyError && error.code === 'bad_request') {
        return { lines: [], note: error.message }
      }
      if (error instanceof CoolifyError && error.code === 'forbidden') {
        return { lines: [], note: `${error.message} Reading runtime logs needs a token Coolify accepts for this application.` }
      }
      throw error
    }
  }

  return { build, history, detail, logs, health }
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
