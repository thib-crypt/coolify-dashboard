import path from 'node:path'
import { DEFAULT_SESSION_TTL_MS, type AuthConfig } from './auth'
import { DEFAULT_METRICS_CONFIG, type MetricsConfig, type StrictHostKey } from './metrics'
import { POLL_ACTIVE_MS, POLL_IDLE_MS } from './poller'
import { DEFAULT_PROBE_CONFIG, type ProbeConfig } from './probes'

export interface BffConfig {
  /** Coolify instance root, no trailing slash and no `/api/v1` suffix. */
  coolifyUrl: string | null
  coolifyToken: string | null
  port: number
  /**
   * Interface to bind. Loopback by default: an unconfigured dashboard has no
   * password, and the write endpoints behind it stop production. The container
   * overrides it to `0.0.0.0` — and warns at boot when it does that without a
   * `DASHBOARD_PASSWORD` (see docs/deployment.md).
   */
  host: string
  /**
   * Built SPA to serve alongside the API, relative to the working directory.
   * `null` — or a directory with no `index.html` — leaves the BFF API-only,
   * which is what development wants: Vite serves the front end there.
   */
  staticDir: string | null
  /** where the SQLite snapshot file lives */
  dataDir: string
  requestTimeoutMs: number
  /** how many deployments to pull per application when building history */
  deploymentHistoryTake: number
  /**
   * Shared secret expected in the query string of `/app/hooks/coolify`.
   * `null` disables the route — Coolify's webhooks are unsigned, so accepting
   * them without a secret would let anyone forge a toast in the dashboard.
   */
  webhookSecret: string | null
  /** poll cadence while a deployment is running / while nothing is (appendix B) */
  pollActiveMs: number
  pollIdleMs: number
  /** outbound HTTP/TLS/TCP probes — the only source of uptime (phase 4) */
  probes: ProbeConfig
  /** Sentinel collector over SSH — the only source of CPU/RAM (phase 5) */
  metrics: MetricsConfig
  /** the dashboard's own password, and how its session cookie is signed (phase 7) */
  auth: AuthConfig
}

export interface ConfiguredBffConfig extends BffConfig {
  coolifyUrl: string
  coolifyToken: string
}

/** Reads `.env` if present — Node ≥ 20.12 does this natively, no dotenv needed. */
export function loadEnvFile(file = '.env'): void {
  try {
    process.loadEnvFile(path.resolve(file))
  } catch {
    // no .env — environment variables may still be set by the runtime
  }
}

const trimUrl = (raw: string) => raw.trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '')

/** `PROBES_ENABLED=false` / `0` / `off` turns the whole prober off. */
const flag = (raw: string | undefined, fallback: boolean): boolean => {
  const value = raw?.trim().toLowerCase()
  if (!value) return fallback
  return !['false', '0', 'no', 'off'].includes(value)
}

/** Comma or space separated list, empty entries dropped. */
const list = (raw: string | undefined): string[] =>
  (raw ?? '').split(/[,\s]+/).map(entry => entry.trim()).filter(Boolean)

function loadProbeConfig(env: NodeJS.ProcessEnv): ProbeConfig {
  const days = Number(env.PROBE_RETENTION_DAYS ?? 7)
  return {
    enabled: flag(env.PROBES_ENABLED, DEFAULT_PROBE_CONFIG.enabled),
    intervalMs: Number(env.PROBE_INTERVAL_MS ?? DEFAULT_PROBE_CONFIG.intervalMs),
    timeoutMs: Number(env.PROBE_TIMEOUT_MS ?? DEFAULT_PROBE_CONFIG.timeoutMs),
    tlsIntervalMs: Number(env.PROBE_TLS_INTERVAL_MS ?? DEFAULT_PROBE_CONFIG.tlsIntervalMs),
    windowMs: DEFAULT_PROBE_CONFIG.windowMs,
    retentionMs: days * 24 * 60 * 60_000,
    concurrency: Number(env.PROBE_CONCURRENCY ?? DEFAULT_PROBE_CONFIG.concurrency),
    only: list(env.PROBE_APPS),
  }
}

/**
 * The SSH key is the opt-in: Coolify exposes no metrics endpoint, so the only
 * way to fill the Fleet gauges is to query Sentinel the way Coolify does, and
 * that needs a key mounted next to the BFF. `METRICS_ENABLED=false` forces the
 * collector off even when a key is present.
 */
function loadMetricsConfig(env: NodeJS.ProcessEnv): MetricsConfig {
  const sshKeyPath = env.METRICS_SSH_KEY?.trim() || null
  const strict = env.METRICS_SSH_STRICT_HOST_KEY?.trim().toLowerCase()
  return {
    enabled: flag(env.METRICS_ENABLED, sshKeyPath !== null),
    intervalMs: Number(env.METRICS_INTERVAL_MS ?? DEFAULT_METRICS_CONFIG.intervalMs),
    timeoutMs: Number(env.METRICS_TIMEOUT_MS ?? DEFAULT_METRICS_CONFIG.timeoutMs),
    sshKeyPath,
    sshUser: env.METRICS_SSH_USER?.trim() || null,
    strictHostKey: (['accept-new', 'yes', 'no'].includes(strict ?? '')
      ? strict
      : DEFAULT_METRICS_CONFIG.strictHostKey) as StrictHostKey,
    concurrency: Number(env.METRICS_CONCURRENCY ?? DEFAULT_METRICS_CONFIG.concurrency),
    historyMinutes: Number(env.METRICS_HISTORY_MINUTES ?? DEFAULT_METRICS_CONFIG.historyMinutes),
    only: list(env.METRICS_SERVERS),
  }
}

/**
 * The dashboard's front door. Everything here is optional, and leaving the
 * password empty keeps the pre-phase-7 behaviour — an open BFF, which
 * `index.ts` refuses to bind to a public interface without saying so.
 */
function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const hours = Number(env.SESSION_TTL_HOURS ?? DEFAULT_SESSION_TTL_MS / 3_600_000)
  return {
    password: env.DASHBOARD_PASSWORD?.trim() || null,
    sessionSecret: env.SESSION_SECRET?.trim() || null,
    sessionTtlMs: Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : DEFAULT_SESSION_TTL_MS,
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  const url = env.COOLIFY_URL?.trim()
  const token = env.COOLIFY_TOKEN?.trim()
  return {
    coolifyUrl: url ? trimUrl(url) : null,
    coolifyToken: token || null,
    // BFF_PORT wins over PORT: in dev the front-end tooling injects its own PORT
    // into the shared environment, and in production PORT is the usual convention.
    port: Number(env.BFF_PORT ?? env.PORT ?? 8787),
    host: env.BFF_HOST?.trim() || '127.0.0.1',
    // Unset means "serve ./dist if it was built"; set-but-empty means "never".
    staticDir: (env.STATIC_DIR === undefined ? 'dist' : env.STATIC_DIR.trim()) || null,
    dataDir: env.DATA_DIR?.trim() || path.resolve('data'),
    requestTimeoutMs: Number(env.COOLIFY_TIMEOUT_MS ?? 10_000),
    deploymentHistoryTake: Number(env.DEPLOYMENT_HISTORY_TAKE ?? 20),
    webhookSecret: env.WEBHOOK_SECRET?.trim() || null,
    pollActiveMs: Number(env.POLL_ACTIVE_MS ?? POLL_ACTIVE_MS),
    pollIdleMs: Number(env.POLL_IDLE_MS ?? POLL_IDLE_MS),
    probes: loadProbeConfig(env),
    metrics: loadMetricsConfig(env),
    auth: loadAuthConfig(env),
  }
}

export function isConfigured(config: BffConfig): config is ConfiguredBffConfig {
  return Boolean(config.coolifyUrl && config.coolifyToken)
}

/** Names of the variables still missing, for the `not_configured` error. */
export function missingConfig(config: BffConfig): string[] {
  const missing: string[] = []
  if (!config.coolifyUrl) missing.push('COOLIFY_URL')
  if (!config.coolifyToken) missing.push('COOLIFY_TOKEN')
  return missing
}
