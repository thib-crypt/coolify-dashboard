/** Per-family TTL cache with single-flight and stale-on-error.
 *
 * Two properties matter here, both about the 200 req/min budget Coolify
 * enforces *per user* (annexe B of PLAN.md):
 *  - single-flight: N concurrent browser tabs hitting /app/overview at once
 *    produce **one** upstream call, not N;
 *  - stale-on-error: a blip upstream degrades the dashboard rather than
 *    blanking it — the caller learns the value is stale and says so.
 */

export interface CacheResult<T> {
  value: T
  /** false when the value was served from an expired entry after a failed refresh */
  fresh: boolean
  /** why the refresh failed, when `fresh` is false */
  error?: unknown
}

interface Entry<T> {
  value?: T
  /** distinguishes "cached undefined" and "placeholder for an in-flight load" */
  hasValue: boolean
  storedAt: number
  inflight?: Promise<T>
}

export class TtlCache {
  #entries = new Map<string, Entry<unknown>>()
  #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  async fetch<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<CacheResult<T>> {
    const entry = this.#entries.get(key) as Entry<T> | undefined

    if (entry?.hasValue && this.#now() - entry.storedAt < ttlMs) {
      return { value: entry.value as T, fresh: true }
    }

    // a refresh is already running — join it instead of firing a second call
    const inflight = entry?.inflight ?? this.#load(key, entry, loader)

    try {
      return { value: await inflight, fresh: true }
    } catch (error) {
      // the failed load restores the previous entry, so re-read it here
      const stale = this.#entries.get(key) as Entry<T> | undefined
      if (stale?.hasValue) return { value: stale.value as T, fresh: false, error }
      throw error
    }
  }

  #load<T>(key: string, previous: Entry<T> | undefined, loader: () => Promise<T>): Promise<T> {
    const placeholder: Entry<T> = {
      value: previous?.value,
      hasValue: previous?.hasValue ?? false,
      storedAt: previous?.storedAt ?? -Infinity,
    }

    const inflight = loader().then(
      value => {
        this.#entries.set(key, { value, hasValue: true, storedAt: this.#now() })
        return value
      },
      error => {
        // keep the stale value around so `fetch` can fall back to it
        if (placeholder.hasValue) this.#entries.set(key, { ...placeholder, inflight: undefined })
        else this.#entries.delete(key)
        throw error
      },
    )

    this.#entries.set(key, { ...placeholder, inflight })
    return inflight
  }

  /** Drops entries whose key starts with `prefix` (all of them when omitted). */
  invalidate(prefix?: string): void {
    if (prefix === undefined) {
      this.#entries.clear()
      return
    }
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) this.#entries.delete(key)
    }
  }
}

/** TTL per resource family — see annexe B of PLAN.md for the budget. */
export const TTL = {
  version: 10 * 60_000,
  team: 5 * 60_000,
  projects: 5 * 60_000,
  environments: 5 * 60_000,
  servers: 60_000,
  applications: 30_000,
  // Per-application, so this one drives the budget as the fleet grows: settings
  // change rarely, and phase 2's toggle can invalidate the key on write.
  applicationDetail: 5 * 60_000,
  deployments: 5_000,
  deploymentHistory: 120_000,
  scheduledTasks: 5 * 60_000,
  databases: 5 * 60_000,
} as const
