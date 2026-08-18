/**
 * Coolify REST API shapes (`/api/v1`), hand-written from `upstream/coolify/openapi.json`
 * and cross-checked against `routes/api.php` + controllers.
 *
 * Do **not** regenerate a client from the OpenAPI spec: it has known drift
 * (called out inline). Fields the dashboard never reads are omitted. Most
 * properties are optional because `serializeApiResponse` reorders keys and
 * Sanctum hides sensitive attributes unless the token has `read:sensitive`.
 *
 * Target: Coolify v4.3.x. Instance: v4.3.2.
 */

export type IsoDateTime = string

export interface ApiErrorBody {
  message: string
}

export type BuildPack =
  | 'nixpacks'
  | 'railpack'
  | 'static'
  | 'dockerfile'
  | 'dockercompose'

export type ProxyType = 'traefik' | 'caddy' | 'none'

/** Resource container status as stored by Coolify, e.g. `"running:healthy"`. */
export type ResourceStatus = string

export type DeploymentStatus =
  | 'queued'
  | 'in_progress'
  | 'finished'
  | 'failed'
  | 'cancelled-by-user'

export type LogStream = 'stdout' | 'stderr'

/**
 * One line of a deployment log. `ApplicationDeploymentQueue.logs` is a **JSON
 * string** of this array — parse, sort by `order`, drop `hidden`.
 * Secrets are already replaced with `REDACTED` server-side.
 */
export interface DeploymentLogLine {
  command: string | null
  output: string
  type: LogStream | string
  timestamp: IsoDateTime
  hidden: boolean
  batch: number
  order?: number
}

export interface User {
  id: number
  name?: string
  email?: string
  email_verified_at?: IsoDateTime | null
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
  two_factor_confirmed_at?: IsoDateTime | null
  force_password_reset?: boolean
  marketing_emails?: boolean
}

export interface Team {
  id: number
  name: string
  description?: string | null
  personal_team?: boolean
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
  show_boarding?: boolean
  custom_server_limit?: string | null
  members?: User[]
}

export interface Project {
  id?: number
  uuid: string
  name: string
  description?: string | null
}

/**
 * OpenAPI Environment schema omits `uuid`. Real list endpoint
 * `GET /projects/{uuid}/environments` returns `{ id, name, uuid }` only
 * (`ProjectController::get_environments`).
 */
export interface Environment {
  id: number
  uuid: string
  name: string
  project_id?: number
  description?: string | null
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
}

export interface EnvironmentVariable {
  id?: number
  uuid: string
  resourceable_type?: string
  resourceable_id?: number
  is_literal?: boolean
  is_multiline?: boolean
  is_preview?: boolean
  is_runtime?: boolean
  is_buildtime?: boolean
  is_shared?: boolean
  is_shown_once?: boolean
  key: string
  /** Absent or redacted without `read:sensitive`. */
  value?: string
  real_value?: string
  comment?: string | null
  version?: string
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
}

export interface ApplicationSetting {
  is_static?: boolean
  is_git_submodules_enabled?: boolean
  is_git_lfs_enabled?: boolean
  is_auto_deploy_enabled?: boolean
  is_force_https_enabled?: boolean
  is_debug_enabled?: boolean
  is_preview_deployments_enabled?: boolean
  is_log_drain_enabled?: boolean
  is_gpu_enabled?: boolean
  is_include_timestamps?: boolean
  is_raw_compose_deployment_enabled?: boolean
  is_build_server_enabled?: boolean
  is_consistent_container_name_enabled?: boolean
  is_gzip_enabled?: boolean
  is_stripprefix_enabled?: boolean
  connect_to_docker_network?: boolean
  custom_internal_name?: string | null
  is_spa?: boolean
  disable_build_cache?: boolean
  docker_images_to_keep?: number
  stop_grace_period?: number | null
}

export interface Application {
  id?: number
  uuid: string
  name: string
  description?: string | null
  fqdn?: string | null
  git_repository?: string
  git_branch?: string
  git_commit_sha?: string
  git_full_url?: string | null
  build_pack?: BuildPack | string
  status?: ResourceStatus
  environment_id?: number
  destination_id?: number
  destination_type?: string
  server_id?: number
  docker_registry_image_name?: string | null
  docker_registry_image_tag?: string | null
  ports_exposes?: string
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
  deleted_at?: IsoDateTime | null
  settings?: ApplicationSetting
}

export interface PatchApplicationBody {
  name?: string
  description?: string | null
  /** Accepted on PATCH /applications/{uuid} (ApplicationsController). */
  is_auto_deploy_enabled?: boolean
  is_force_https_enabled?: boolean
  domains?: string
}

export interface ApplicationLogsResponse {
  logs: string
}

export interface RollbackImage {
  image?: string
  tag?: string
  created_at?: IsoDateTime
}

export interface ServerSetting {
  id?: number
  concurrent_builds?: number
  deployment_queue_limit?: number
  is_build_server?: boolean
  is_jump_server?: boolean
  is_reachable?: boolean
  is_usable?: boolean
  is_sentinel_enabled?: boolean
  is_metrics_enabled?: boolean
  is_swarm_manager?: boolean
  is_swarm_worker?: boolean
  is_terminal_enabled?: boolean
  force_disabled?: boolean
  sentinel_token?: string
  sentinel_metrics_history_days?: number
  sentinel_metrics_refresh_rate_seconds?: number
  wildcard_domain?: string | null
  docker_cleanup_frequency?: string
  docker_cleanup_threshold?: number
  connection_timeout?: number
  server_id?: number
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
}

export interface Server {
  id?: number
  uuid: string
  name: string
  description?: string | null
  ip?: string
  user?: string
  port?: number
  proxy?: Record<string, unknown>
  proxy_type?: ProxyType | string
  high_disk_usage_notification_sent?: boolean
  unreachable_notification_sent?: boolean
  unreachable_count?: number
  /** Present on the model, missing from the OpenAPI Server schema. */
  sentinel_updated_at?: IsoDateTime | null
  settings?: ServerSetting
}

export interface SentinelSettings {
  is_sentinel_enabled?: boolean
  is_metrics_enabled?: boolean
  is_sentinel_debug_enabled?: boolean
  /** Only with `read:sensitive`. */
  sentinel_token?: string
  sentinel_metrics_refresh_rate_seconds?: number
  sentinel_metrics_history_days?: number
  sentinel_push_interval_seconds?: number
  /** Only with `read:sensitive`. */
  sentinel_custom_url?: string | null
  sentinel_updated_at?: IsoDateTime | null
}

export interface PatchSentinelBody {
  is_sentinel_enabled?: boolean
  is_metrics_enabled?: boolean
  is_sentinel_debug_enabled?: boolean
  sentinel_token?: string
  sentinel_metrics_refresh_rate_seconds?: number
  sentinel_metrics_history_days?: number
  sentinel_push_interval_seconds?: number
  sentinel_custom_url?: string | null
}

export interface ServerResource {
  id?: number
  uuid: string
  name: string
  type?: string
  status?: ResourceStatus
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
}

/**
 * OpenAPI schema is missing `finished_at`, `build_server_id`, `horizon_job_id`.
 * `application_id` is an integer in the DB, typed as string in OpenAPI.
 * `logs` is a JSON **string** of `DeploymentLogLine[]`, hidden without
 * `read:sensitive` + admin/owner.
 */
export interface ApplicationDeploymentQueue {
  id?: number
  application_id?: number | string
  deployment_uuid: string
  pull_request_id?: number
  docker_registry_image_tag?: string | null
  force_rebuild?: boolean
  commit?: string | null
  commit_message?: string | null
  status: DeploymentStatus | string
  is_webhook?: boolean
  is_api?: boolean
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
  /** ISO datetime. Duration = finished_at − created_at (no `started_at`). */
  finished_at?: IsoDateTime | null
  logs?: string | null
  current_process_id?: string | null
  restart_only?: boolean
  git_type?: string | null
  server_id?: number
  application_name?: string
  server_name?: string
  deployment_url?: string | null
  destination_id?: number | string
  only_this_server?: boolean
  rollback?: boolean
  build_server_id?: number | null
}

/**
 * Spec says this is `Application[]`. Controller returns
 * `{ count, deployments }` from `Application::deployments()`.
 */
export interface ApplicationDeploymentsPage {
  count: number
  deployments: ApplicationDeploymentQueue[]
}

export interface DeployBody {
  uuid?: string
  tag?: string
  force?: boolean
  pull_request_id?: number
  pr?: number
  docker_tag?: string
}

export interface DeployResultItem {
  message: string
  resource_uuid?: string
  deployment_uuid?: string
}

export interface DeployResponse {
  deployments?: DeployResultItem[]
  message?: string
}

export interface CancelDeploymentResponse {
  message: string
}

export interface StartApplicationResponse {
  message: string
  deployment_uuid?: string
}

export interface MessageResponse {
  message: string
}

export interface Database {
  id?: number
  uuid: string
  name: string
  description?: string | null
  status?: ResourceStatus
  environment_id?: number
  destination_id?: number
  image?: string
  is_public?: boolean
  public_port?: number | null
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
  /** Attached by `GET /databases` (not in OpenAPI). */
  backup_configs?: ScheduledDatabaseBackup[]
}

/**
 * OpenAPI `GET /databases` and `GET /databases/{uuid}/backups` are typed as
 * `string` ("Content is very complex"). Real payload is JSON objects.
 */
export interface ScheduledDatabaseBackup {
  id?: number
  uuid: string
  enabled?: boolean
  frequency?: string
  save_s3?: boolean
  database_type?: string
  database_id?: number
  databases_to_backup?: string | null
  description?: string | null
  timeout?: number
  disable_local_backup?: boolean
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
  latest_log?: ScheduledDatabaseBackupExecution | null
  executions?: ScheduledDatabaseBackupExecution[]
}

export interface ScheduledDatabaseBackupExecution {
  uuid: string
  filename?: string | null
  size?: number | null
  status?: string
  message?: string | null
  created_at?: IsoDateTime
  finished_at?: IsoDateTime | null
  s3_uploaded?: boolean
}

export interface BackupExecutionsResponse {
  executions: ScheduledDatabaseBackupExecution[]
}

export interface ScheduledTask {
  id?: number
  uuid: string
  enabled?: boolean
  name: string
  command?: string
  frequency?: string
  container?: string | null
  timeout?: number
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
}

export interface ScheduledTaskExecution {
  uuid: string
  status?: string
  message?: string | null
  retry_count?: number
  duration?: number | string | null
  started_at?: IsoDateTime | null
  finished_at?: IsoDateTime | null
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
}

export interface Service {
  id?: number
  uuid: string
  name: string
  environment_id?: number
  server_id?: number
  description?: string | null
  service_type?: string | null
  status?: ResourceStatus
  created_at?: IsoDateTime
  updated_at?: IsoDateTime
  deleted_at?: IsoDateTime | null
}

/**
 * `GET /resources` is unspecified in OpenAPI (`type: string`). Controller
 * flattens applications, services and databases and adds `status` + `type`.
 */
export interface Resource {
  uuid: string
  name: string
  status?: ResourceStatus
  type?: string
  environment_id?: number
  [key: string]: unknown
}

export interface WebhookNotificationSettings {
  team_id?: number
  webhook_enabled?: boolean
  /** Hidden without `read:sensitive`. */
  webhook_url?: string
  deployment_success_webhook_notifications?: boolean
  deployment_failure_webhook_notifications?: boolean
  status_change_webhook_notifications?: boolean
  backup_success_webhook_notifications?: boolean
  backup_failure_webhook_notifications?: boolean
  scheduled_task_success_webhook_notifications?: boolean
  scheduled_task_failure_webhook_notifications?: boolean
  docker_cleanup_success_webhook_notifications?: boolean
  docker_cleanup_failure_webhook_notifications?: boolean
  server_disk_usage_webhook_notifications?: boolean
  server_reachable_webhook_notifications?: boolean
  server_unreachable_webhook_notifications?: boolean
  server_patch_webhook_notifications?: boolean
  traefik_outdated_webhook_notifications?: boolean
}

export type WebhookEvent =
  | 'deployment_success'
  | 'deployment_failed'
  | 'status_changed'
  | 'backup_success'
  | 'backup_failed'
  | 'backup_success_with_s3_warning'
  | 'task_success'
  | 'task_failed'
  | 'server_reachable'
  | 'server_unreachable'
  | 'high_disk_usage'
  | 'container_stopped'
  | 'container_restarted'
  | 'docker_cleanup_success'
  | 'docker_cleanup_failed'
  | 'traefik_version_outdated'
  | 'server_patch_check'
  | 'server_patch_check_error'
  | 'restart_limit_reached'
  | 'test'

/**
 * Outgoing Coolify webhooks are **unsigned**. Authenticate with a secret in
 * the receiver URL. Deduplicate on (`event` + `deployment_uuid` / resource).
 */
export interface CoolifyWebhookPayload {
  event: WebhookEvent | string
  success?: boolean
  message?: string
  application_name?: string
  application_uuid?: string
  deployment_uuid?: string
  deployment_url?: string
  fqdn?: string
  project?: string
  environment?: string
  server_name?: string
  server_uuid?: string
  [key: string]: unknown
}

/**
 * `GET /api/v1/version` and `GET /api/v1/health` (also `/api/health`) return
 * **plain text**, not JSON. Do not `res.json()` these.
 */
export type VersionText = string
export type HealthText = 'OK' | string
