import fs from 'node:fs'
import path from 'node:path'

/** One hourly row of the numbers the Coolify API cannot give us historically:
    deltas ("+2 this week") and KPI sparklines are computed from these. */
export interface KpiSample {
  applications: number
  deployments24h: number
  /** share of successful deployments over the window, 0–100 */
  deploySuccessPct: number | null
  medianDeployMs: number | null
  backups24h: number | null
}

export interface SnapshotRow extends KpiSample {
  takenAt: number
}

export interface SnapshotStore {
  readonly kind: 'sqlite' | 'memory'
  /** Writes at most one row per environment per hour. Returns true if it wrote. */
  record(env: string, sample: KpiSample, now: number): boolean
  /** Oldest → newest. */
  history(env: string, limit: number): SnapshotRow[]
  /** Most recent snapshot taken at or before `at`, if any. */
  before(env: string, at: number): SnapshotRow | null
  close(): void
}

export const SNAPSHOT_INTERVAL_MS = 60 * 60_000

const COLUMNS = 'taken_at, applications, deployments_24h, deploy_success_pct, median_deploy_ms, backups_24h'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kpi_snapshot (
    env TEXT NOT NULL,
    taken_at INTEGER NOT NULL,
    applications INTEGER NOT NULL,
    deployments_24h INTEGER NOT NULL,
    deploy_success_pct REAL,
    median_deploy_ms INTEGER,
    backups_24h INTEGER,
    PRIMARY KEY (env, taken_at)
  );
`

type Row = Record<string, unknown>

const toRow = (r: Row): SnapshotRow => ({
  takenAt: Number(r.taken_at),
  applications: Number(r.applications),
  deployments24h: Number(r.deployments_24h),
  deploySuccessPct: r.deploy_success_pct == null ? null : Number(r.deploy_success_pct),
  medianDeployMs: r.median_deploy_ms == null ? null : Number(r.median_deploy_ms),
  backups24h: r.backups_24h == null ? null : Number(r.backups_24h),
})

/** Falls back to an in-process ring buffer when `node:sqlite` is unavailable
    (Node < 22.5, or built without SQLite): the dashboard then loses its
    history across restarts but never fails to render. */
export async function createStore(dataDir: string): Promise<SnapshotStore> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    fs.mkdirSync(dataDir, { recursive: true })
    const db = new DatabaseSync(path.join(dataDir, 'dashboard.sqlite'))
    db.exec(SCHEMA)

    const insert = db.prepare(
      `INSERT OR REPLACE INTO kpi_snapshot (env, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const lastAt = db.prepare('SELECT MAX(taken_at) AS last FROM kpi_snapshot WHERE env = ?')
    const recent = db.prepare(
      `SELECT ${COLUMNS} FROM kpi_snapshot WHERE env = ? ORDER BY taken_at DESC LIMIT ?`,
    )
    const atOrBefore = db.prepare(
      `SELECT ${COLUMNS} FROM kpi_snapshot WHERE env = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1`,
    )

    return {
      kind: 'sqlite',
      record(env, sample, now) {
        const last = (lastAt.get(env) as Row | undefined)?.last
        if (last != null && now - Number(last) < SNAPSHOT_INTERVAL_MS) return false
        insert.run(
          env,
          now,
          sample.applications,
          sample.deployments24h,
          sample.deploySuccessPct,
          sample.medianDeployMs,
          sample.backups24h,
        )
        return true
      },
      history(env, limit) {
        return (recent.all(env, limit) as Row[]).map(toRow).reverse()
      },
      before(env, at) {
        const row = atOrBefore.get(env, at) as Row | undefined
        return row ? toRow(row) : null
      },
      close() {
        db.close()
      },
    }
  } catch {
    return createMemoryStore()
  }
}

export function createMemoryStore(limit = 24 * 14): SnapshotStore {
  const rows = new Map<string, SnapshotRow[]>()
  return {
    kind: 'memory',
    record(env, sample, now) {
      const list = rows.get(env) ?? []
      const last = list.at(-1)
      if (last && now - last.takenAt < SNAPSHOT_INTERVAL_MS) return false
      list.push({ ...sample, takenAt: now })
      if (list.length > limit) list.shift()
      rows.set(env, list)
      return true
    },
    history(env, count) {
      return (rows.get(env) ?? []).slice(-count)
    },
    before(env, at) {
      const list = rows.get(env) ?? []
      for (let i = list.length - 1; i >= 0; i--) {
        const row = list[i]
        if (row && row.takenAt <= at) return row
      }
      return null
    },
    close() {
      rows.clear()
    },
  }
}
