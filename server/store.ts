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

/** One HTTP probe result. Coolify tracks no uptime, so the only honest source
    for a percentage is a table of measurements this BFF took itself. */
export interface ProbeStats {
  samples: number
  up: number
  /** 0–100 over the requested window; 0 when there is no sample */
  uptimePct: number
  avgLatencyMs: number | null
}

export interface ProbeStore {
  recordProbe(target: string, at: number, ok: boolean, latencyMs: number | null): void
  probeStats(target: string, since: number): ProbeStats
  /** Drops samples older than `before` — called hourly by the prober. */
  pruneProbes(before: number): void
}

/** What `createStore` hands back: both histories live in the same file. */
export type Store = SnapshotStore & ProbeStore

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

  CREATE TABLE IF NOT EXISTS probe_sample (
    target TEXT NOT NULL,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    PRIMARY KEY (target, at)
  );
`

const EMPTY_STATS: ProbeStats = { samples: 0, up: 0, uptimePct: 0, avgLatencyMs: null }

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
export async function createStore(dataDir: string): Promise<Store> {
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

    const insertProbe = db.prepare(
      'INSERT OR REPLACE INTO probe_sample (target, at, ok, latency_ms) VALUES (?, ?, ?, ?)',
    )
    // AVG over successful samples only: a timeout has no latency to average in,
    // and counting it as zero would make an outage look fast.
    const statsFor = db.prepare(
      `SELECT COUNT(*) AS samples,
              SUM(ok) AS up,
              AVG(CASE WHEN ok = 1 THEN latency_ms END) AS avg_latency
       FROM probe_sample WHERE target = ? AND at >= ?`,
    )
    const deleteOldProbes = db.prepare('DELETE FROM probe_sample WHERE at < ?')

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
      recordProbe(target, at, ok, latencyMs) {
        insertProbe.run(target, at, ok ? 1 : 0, latencyMs == null ? null : Math.round(latencyMs))
      },
      probeStats(target, since) {
        const row = statsFor.get(target, since) as Row | undefined
        const samples = Number(row?.samples ?? 0)
        if (samples === 0) return EMPTY_STATS
        const up = Number(row?.up ?? 0)
        return {
          samples,
          up,
          uptimePct: (up / samples) * 100,
          avgLatencyMs: row?.avg_latency == null ? null : Math.round(Number(row.avg_latency)),
        }
      },
      pruneProbes(before) {
        deleteOldProbes.run(before)
      },
      close() {
        db.close()
      },
    }
  } catch {
    return createMemoryStore()
  }
}

/** Keeps the same window as SQLite would, minus the file: 24 h of probes at one
    per minute is 1440 samples, so the cap holds a full day per target. */
const MEMORY_PROBE_LIMIT = 2000

export function createMemoryStore(limit = 24 * 14): Store {
  const rows = new Map<string, SnapshotRow[]>()
  const probes = new Map<string, Array<{ at: number; ok: boolean; latencyMs: number | null }>>()
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
    recordProbe(target, at, ok, latencyMs) {
      const list = probes.get(target) ?? []
      list.push({ at, ok, latencyMs })
      if (list.length > MEMORY_PROBE_LIMIT) list.shift()
      probes.set(target, list)
    },
    probeStats(target, since) {
      const list = (probes.get(target) ?? []).filter(sample => sample.at >= since)
      if (list.length === 0) return EMPTY_STATS
      const up = list.filter(sample => sample.ok).length
      const latencies = list.filter(sample => sample.ok && sample.latencyMs != null).map(s => s.latencyMs as number)
      return {
        samples: list.length,
        up,
        uptimePct: (up / list.length) * 100,
        avgLatencyMs: latencies.length === 0
          ? null
          : Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length),
      }
    },
    pruneProbes(before) {
      for (const [target, list] of probes) {
        const kept = list.filter(sample => sample.at >= before)
        if (kept.length === 0) probes.delete(target)
        else probes.set(target, kept)
      }
    },
    close() {
      rows.clear()
      probes.clear()
    },
  }
}
