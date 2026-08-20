import type { ConfiguredBffConfig } from '../config'
import type * as Api from '../../shared/coolify-api'

/** Why an upstream call failed, in terms the BFF can turn into a useful message. */
export type CoolifyErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'api_disabled'
  | 'ip_blocked'
  | 'rate_limited'
  /** 429 too, but from the deployment queue rather than the rate limiter */
  | 'queue_full'
  | 'not_found'
  | 'bad_request'
  | 'unreachable'
  | 'invalid_response'
  | 'http'

export class CoolifyError extends Error {
  readonly code: CoolifyErrorCode
  readonly status?: number
  readonly path?: string
  readonly retryAfterSeconds?: number

  constructor(
    message: string,
    options: { code: CoolifyErrorCode; status?: number; path?: string; retryAfterSeconds?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause })
    this.name = 'CoolifyError'
    this.code = options.code
    this.status = options.status
    this.path = options.path
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

/**
 * Maps an upstream response to a `CoolifyErrorCode`.
 *
 * Coolify does **not** use 401 for a bad token on most routes: `getTeamIdFromToken()`
 * returns `invalidTokenResponse()`, which is **400 "Invalid token."**
 * (`bootstrap/helpers/api.php`). 403 covers three very different situations,
 * separated here by message so the UI can tell the user what to actually fix.
 */
export function classify(status: number, message: string): CoolifyErrorCode {
  const text = message.toLowerCase()
  // A full deployment queue is a 429 from `/deploy` and a 400 from `/rollback`,
  // with the same sentence underneath both. The sentence is the reliable half —
  // and it is worth catching, because `queue_full` is the one 4xx that tells the
  // caller to simply try again in a minute.
  if (text.includes('queue is full')) return 'queue_full'
  if (status === 401) return 'unauthorized'
  if (status === 400) return text.includes('invalid token') ? 'unauthorized' : 'bad_request'
  if (status === 403) {
    if (text.includes('api is disabled')) return 'api_disabled'
    if (text.includes('not allowed to access the api')) return 'ip_blocked'
    return 'forbidden'
  }
  if (status === 404) return 'not_found'
  // Both the rate limiter and a full deployment queue answer 429 with
  // `Retry-After` (helpers/applications.php); the queue is caught above.
  if (status === 429) return 'rate_limited'
  return 'http'
}

export interface CoolifyClient {
  /** plain text, **not** JSON */
  version(): Promise<string>
  team(): Promise<Api.Team>
  projects(): Promise<Api.Project[]>
  environments(projectUuid: string): Promise<Api.Environment[]>
  applications(): Promise<Api.Application[]>
  application(uuid: string): Promise<Api.Application>
  servers(): Promise<Api.Server[]>
  /**
   * Sentinel's configuration for one server (phase 5). `sentinel_token` — the
   * only reason the metrics collector calls this — is withheld unless the token
   * carries `read:sensitive`, in which case the field is simply absent.
   */
  serverSentinel(uuid: string): Promise<Api.SentinelSettings>
  /** only `queued` + `in_progress` — history is per application */
  runningDeployments(): Promise<Api.ApplicationDeploymentQueue[]>
  /**
   * The only way to see a deployment once it has left `/deployments`: that list
   * drops anything not `queued`/`in_progress`, so a build that just ended is
   * invisible there. The poller reads its terminal status here.
   */
  deployment(uuid: string): Promise<Api.ApplicationDeploymentQueue>
  applicationDeployments(uuid: string, take: number): Promise<Api.ApplicationDeploymentsPage>
  applicationScheduledTasks(uuid: string): Promise<Api.ScheduledTask[]>
  /** `value` is *absent*, not redacted, without `read:sensitive` + an admin role. */
  applicationEnvs(uuid: string): Promise<Api.EnvironmentVariable[]>
  /**
   * Runtime container logs. **400 `Application is not running.`** whenever the
   * container is stopped, which is a state and not a failure — the caller is
   * expected to say so rather than to report an error.
   */
  applicationLogs(uuid: string, lines: number): Promise<Api.ApplicationLogsResponse>
  /** Images already on the server, newest first, with the running one flagged. */
  rollbackImages(uuid: string): Promise<Api.RollbackImagesResponse>
  services(): Promise<Api.Service[]>
  serviceScheduledTasks(uuid: string): Promise<Api.ScheduledTask[]>
  /** each database carries `backup_configs` with their `latest_log` */
  databases(): Promise<Api.Database[]>
  /** same configs as `backup_configs`, but with the full `executions` list */
  databaseBackups(uuid: string): Promise<Api.ScheduledDatabaseBackup[]>

  /* --- writes (phase 2) ------------------------------------------------- */

  /** `POST /deploy` — answers 200 even when it queued nothing, see `readDeployResponse`. */
  deploy(uuid: string, options?: { force?: boolean }): Promise<Api.DeployResponse>
  /** 400 when the deployment is already finished, 403 when it is another team's. */
  cancelDeployment(uuid: string): Promise<Api.CancelDeploymentResponse>
  /** `start` and `restart` queue a deployment; `stop` acts immediately. */
  applicationAction(uuid: string, action: ApplicationAction): Promise<Api.StartApplicationResponse>
  patchApplication(uuid: string, body: Api.PatchApplicationBody): Promise<void>
  /**
   * Redeploys a tag that is already built. `commit` is the *tag* from
   * `rollbackImages`, and it is the only field the endpoint accepts — an extra
   * one is a 422. Like `/deploy`, a skipped rollback answers 200 with a message
   * and no `deployment_uuid`; unlike it, a full queue answers **400**, not 429.
   */
  rollback(uuid: string, commit: string): Promise<Api.RollbackResponse>
  runScheduledTask(owner: TaskOwner, ownerUuid: string, taskUuid: string): Promise<Api.MessageResponse>

  /* --- diagnostics (phase 7) -------------------------------------------- */

  /**
   * Whether this token carries `deploy` or `write` — asked without doing
   * anything at all.
   *
   * Coolify keeps a GET beside each of those POST routes whose only job is to
   * answer *"This endpoint has changed to a POST request."* (`post_required`),
   * and those GETs sit behind the same `api.ability` middleware as the real
   * action. So `GET /deploy` and `GET /enable` are ability probes with no side
   * effect: **405 is a yes**, 403 is a no, and the message says which no —
   * missing ability, or a token whose abilities exceed its owner's team role.
   */
  abilityProbe(ability: ProbedAbility): Promise<AbilityVerdict>
}

/** The two abilities that have a side-effect-free route to ask about. */
export type ProbedAbility = 'deploy' | 'write'

export interface AbilityVerdict {
  granted: boolean
  /**
   * `granted` — the probe answered 405.
   * `missing` — the ability is not on the token.
   * `role` — the abilities exceed the owner's role in the team (member, not admin).
   * `unavailable` — the instance never answered, so nothing was learned.
   */
  reason: 'granted' | 'missing' | 'role' | 'unavailable'
  /** Coolify's own wording, or ours when it did not answer */
  message: string
}

export type ApplicationAction = 'start' | 'restart' | 'stop'
export type TaskOwner = 'application' | 'service'


/** What `request()` needs beyond a path: everything else is fixed by the client. */
interface Init {
  method?: 'GET' | 'POST' | 'PATCH'
  /** serialised as JSON; omit entirely for bodyless calls */
  body?: unknown
}

export function createCoolifyClient(config: ConfiguredBffConfig): CoolifyClient {
  const base = `${config.coolifyUrl}/api/v1`

  /**
   * `start`/`stop`/`restart` moved from GET to POST; instances older than that
   * answer 405 to POST, and current ones answer 405 to GET
   * (`OtherController::post_required`). So: try POST, fall back to GET **once**,
   * and remember which one this instance speaks.
   */
  let actionMethod: 'POST' | 'GET' | null = null

  async function request(path: string, init: Init = {}): Promise<Response> {
    const method = init.method ?? 'GET'
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.coolifyToken}`,
          Accept: 'application/json',
          // Writes without `Content-Type: application/json` **and** a non-empty
          // body are rejected with 400 by `validateIncomingRequest()`.
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      })
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError'
      throw new CoolifyError(
        timedOut
          ? `Coolify did not answer ${method} ${path} within ${config.requestTimeoutMs} ms`
          : `Cannot reach Coolify at ${config.coolifyUrl}`,
        { code: 'unreachable', path, cause },
      )
    }

    if (res.ok) return res

    // error bodies are `{ message }`, but a proxy in front of Coolify may return HTML
    const body = await res.text().catch(() => '')
    let message = body.slice(0, 300)
    try {
      const parsed = JSON.parse(body) as Partial<Api.ApiErrorBody>
      if (typeof parsed?.message === 'string') message = parsed.message
    } catch {
      // keep the raw snippet
    }

    const retryAfter = Number(res.headers.get('retry-after'))
    throw new CoolifyError(message || `${res.status} ${res.statusText}`, {
      code: classify(res.status, message),
      status: res.status,
      path,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    })
  }

  async function getJson<T>(path: string, init?: Init): Promise<T> {
    const res = await request(path, init)
    const text = await res.text()
    try {
      return JSON.parse(text) as T
    } catch (cause) {
      throw new CoolifyError(`Coolify returned a non-JSON body for ${path}`, {
        code: 'invalid_response',
        status: res.status,
        path,
        cause,
      })
    }
  }

  async function getText(path: string): Promise<string> {
    return (await request(path)).text()
  }

  /** Endpoints that return a bare array can legitimately be empty; anything
      that is not an array means the shape drifted, and guessing would be worse. */
  async function getArray<T>(path: string): Promise<T[]> {
    const value = await getJson<unknown>(path)
    if (!Array.isArray(value)) {
      throw new CoolifyError(`Expected an array from ${path}`, { code: 'invalid_response', path })
    }
    return value as T[]
  }

  /** `post_required` answers 405 to everyone the ability middleware let through. */
  const ABILITY_PROBES: Record<ProbedAbility, string> = { deploy: '/deploy', write: '/enable' }

  return {
    version: () => getText('/version'),
    team: () => getJson<Api.Team>('/team'),
    projects: () => getArray<Api.Project>('/projects'),
    environments: uuid => getArray<Api.Environment>(`/projects/${encodeURIComponent(uuid)}/environments`),
    applications: () => getArray<Api.Application>('/applications'),
    application: uuid => getJson<Api.Application>(`/applications/${encodeURIComponent(uuid)}`),
    servers: () => getArray<Api.Server>('/servers'),
    serverSentinel: uuid => getJson<Api.SentinelSettings>(`/servers/${encodeURIComponent(uuid)}/sentinel`),
    runningDeployments: () => getArray<Api.ApplicationDeploymentQueue>('/deployments'),
    deployment: uuid =>
      getJson<Api.ApplicationDeploymentQueue>(`/deployments/${encodeURIComponent(uuid)}`),
    applicationDeployments: (uuid, take) =>
      getJson<Api.ApplicationDeploymentsPage>(
        `/deployments/applications/${encodeURIComponent(uuid)}?skip=0&take=${take}`,
      ),
    applicationEnvs: uuid => getArray<Api.EnvironmentVariable>(`/applications/${encodeURIComponent(uuid)}/envs`),
    applicationLogs: (uuid, lines) =>
      getJson<Api.ApplicationLogsResponse>(
        `/applications/${encodeURIComponent(uuid)}/logs?lines=${encodeURIComponent(String(lines))}`,
      ),
    rollbackImages: uuid =>
      getJson<Api.RollbackImagesResponse>(`/applications/${encodeURIComponent(uuid)}/rollback-images`),
    rollback: (uuid, commit) =>
      getJson<Api.RollbackResponse>(`/applications/${encodeURIComponent(uuid)}/rollback`, {
        method: 'POST',
        body: { commit },
      }),

    applicationScheduledTasks: uuid =>
      getArray<Api.ScheduledTask>(`/applications/${encodeURIComponent(uuid)}/scheduled-tasks`),
    services: () => getArray<Api.Service>('/services'),
    serviceScheduledTasks: uuid =>
      getArray<Api.ScheduledTask>(`/services/${encodeURIComponent(uuid)}/scheduled-tasks`),
    databases: () => getArray<Api.Database>('/databases'),
    databaseBackups: uuid =>
      getArray<Api.ScheduledDatabaseBackup>(`/databases/${encodeURIComponent(uuid)}/backups`),

    deploy: (uuid, options) =>
      getJson<Api.DeployResponse>('/deploy', {
        method: 'POST',
        body: { uuid, ...(options?.force ? { force: true } : {}) } satisfies Api.DeployBody,
      }),

    cancelDeployment: uuid =>
      getJson<Api.CancelDeploymentResponse>(`/deployments/${encodeURIComponent(uuid)}/cancel`, {
        method: 'POST',
      }),

    applicationAction: async (uuid, action) => {
      const path = `/applications/${encodeURIComponent(uuid)}/${action}`
      const call = (method: 'POST' | 'GET') => getJson<Api.StartApplicationResponse>(path, { method })

      if (actionMethod) return call(actionMethod)

      try {
        const result = await call('POST')
        actionMethod = 'POST'
        return result
      } catch (error) {
        if (!(error instanceof CoolifyError) || error.status !== 405) throw error
        try {
          const result = await call('GET')
          actionMethod = 'GET'
          return result
        } catch {
          // Neither verb works: the POST rejection is the one worth reporting,
          // since every supported instance takes POST here.
          throw error
        }
      }
    },

    patchApplication: async (uuid, body) => {
      await request(`/applications/${encodeURIComponent(uuid)}`, { method: 'PATCH', body })
    },

    abilityProbe: async ability => {
      try {
        await request(ABILITY_PROBES[ability])
        // A 2xx here would mean Coolify started answering this GET for real,
        // which no version does — but it did let the call through.
        return { granted: true, reason: 'granted', message: 'Granted.' }
      } catch (error) {
        if (!(error instanceof CoolifyError)) throw error
        if (error.status === 405) return { granted: true, reason: 'granted', message: 'Granted.' }
        if (error.status === 403) {
          // `ApiAbility` sends this exact refusal when the token's abilities
          // exceed its owner's role — a different fix from ticking a box.
          const role = error.message.toLowerCase().includes('exceed your current role')
          return { granted: false, reason: role ? 'role' : 'missing', message: error.message }
        }
        return { granted: false, reason: 'unavailable', message: error.message }
      }
    },

    runScheduledTask: (owner, ownerUuid, taskUuid) =>
      getJson<Api.MessageResponse>(
        `/${owner}s/${encodeURIComponent(ownerUuid)}/scheduled-tasks/${encodeURIComponent(taskUuid)}/execute`,
        { method: 'POST' },
      ),
  }
}
