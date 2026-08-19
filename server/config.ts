import path from 'node:path'

export interface BffConfig {
  /** Coolify instance root, no trailing slash and no `/api/v1` suffix. */
  coolifyUrl: string | null
  coolifyToken: string | null
  port: number
  /** where the SQLite snapshot file lives */
  dataDir: string
  requestTimeoutMs: number
  /** how many deployments to pull per application when building history */
  deploymentHistoryTake: number
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  const url = env.COOLIFY_URL?.trim()
  const token = env.COOLIFY_TOKEN?.trim()
  return {
    coolifyUrl: url ? trimUrl(url) : null,
    coolifyToken: token || null,
    // BFF_PORT wins over PORT: in dev the front-end tooling injects its own PORT
    // into the shared environment, and in production PORT is the usual convention.
    port: Number(env.BFF_PORT ?? env.PORT ?? 8787),
    dataDir: env.DATA_DIR?.trim() || path.resolve('data'),
    requestTimeoutMs: Number(env.COOLIFY_TIMEOUT_MS ?? 10_000),
    deploymentHistoryTake: Number(env.DEPLOYMENT_HISTORY_TAKE ?? 20),
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
