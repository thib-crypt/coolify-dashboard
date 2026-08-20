/**
 * Facts that only a webhook ever carries (phase 4 of docs/roadmap.md).
 *
 * Almost everything the insights engine needs is readable from the REST API,
 * which is what makes the dashboard work for an instance that cannot reach this
 * BFF at all. One thing is not: the **disk usage percentage**. `GET /servers`
 * says whether Coolify has sent a `high_disk_usage` notification
 * (`high_disk_usage_notification_sent`), never how full the disk is — only the
 * webhook payload has the number.
 *
 * So this is a small, bounded side-channel: values keep for a while, then
 * expire. An expired value is not "0 %", it is "we no longer know", and the
 * insight falls back to its wording without a figure rather than showing a
 * number that stopped being true hours ago.
 */

export type SignalKind = 'disk_usage'

export interface Signal {
  kind: SignalKind
  /** the resource the value is about — a server name, as webhooks carry names, not uuids */
  subject: string
  value: number
  at: number
}

/** How long a value stays worth showing. A disk fills slowly; six hours is
    optimistic enough to be useful and short enough to expire before it lies. */
export const SIGNAL_TTL_MS: Record<SignalKind, number> = {
  disk_usage: 6 * 60 * 60_000,
}

export interface SignalStore {
  record(signal: Signal): void
  /** Most recent value for this subject, or `null` when there is none in the window. */
  latest(kind: SignalKind, subject: string, now: number): Signal | null
  readonly size: number
}

const keyOf = (kind: SignalKind, subject: string) => `${kind}:${subject.toLowerCase()}`

export function createSignalStore(): SignalStore {
  const signals = new Map<string, Signal>()

  return {
    record(signal) {
      const key = keyOf(signal.kind, signal.subject)
      const previous = signals.get(key)
      // Webhook retries can arrive out of order; the newest reading wins.
      if (previous && previous.at > signal.at) return
      signals.set(key, signal)
    },

    latest(kind, subject, now) {
      const key = keyOf(kind, subject)
      const signal = signals.get(key)
      if (!signal) return null
      if (now - signal.at >= SIGNAL_TTL_MS[kind]) {
        signals.delete(key)
        return null
      }
      return signal
    },

    get size() {
      return signals.size
    },
  }
}
