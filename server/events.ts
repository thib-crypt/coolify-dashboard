/**
 * The push side of the BFF (phase 3 of docs/roadmap.md): one in-process hub, N browser
 * tabs hanging off it over SSE.
 *
 * Two producers feed the same hub and they overlap on purpose — Coolify's
 * outgoing webhooks are the fast path when the instance is configured for them,
 * the adaptive poller is the floor when it is not. So the hub deduplicates:
 * `publish(event, key)` drops a repeat of `key` seen within the last two
 * minutes. That single mechanism covers both overlaps at once:
 *
 *  - Coolify retries a failed webhook **five times** (`SendWebhookJob::$tries`),
 *    and the payloads carry no delivery id to tell a retry from a new event;
 *  - the poller notices a deployment finishing a few seconds after the webhook
 *    already said so.
 *
 * The hub also tells its owner when the subscriber count leaves or returns to
 * zero, which is what starts and stops the poller: nobody watching, nothing
 * polled, no upstream budget spent.
 */

import type { LiveEvent } from '../shared/bff'

export type LiveListener = (event: LiveEvent) => void

export const DEDUPE_WINDOW_MS = 2 * 60_000

export interface EventHub {
  /** Broadcasts to every subscriber. Returns false when `key` was a repeat. */
  publish(event: LiveEvent, key?: string): boolean
  subscribe(listener: LiveListener): () => void
  readonly subscribers: number
}

export interface HubOptions {
  /** Fired on the 0 → 1 and 1 → 0 transitions only, never in between. */
  onActivity?: (hasSubscribers: boolean) => void
  now?: () => number
  dedupeWindowMs?: number
}

export function createEventHub(options: HubOptions = {}): EventHub {
  const now = options.now ?? Date.now
  const window = options.dedupeWindowMs ?? DEDUPE_WINDOW_MS
  const listeners = new Set<LiveListener>()
  const seen = new Map<string, number>()

  /** Cheap enough to run on every keyed publish: the map holds seconds of traffic. */
  function prune(at: number): void {
    for (const [key, stamp] of seen) {
      if (at - stamp >= window) seen.delete(key)
    }
  }

  return {
    publish(event, key) {
      const at = now()
      if (key !== undefined) {
        prune(at)
        if (seen.has(key)) return false
        seen.set(key, at)
      }
      // A throwing subscriber is one dead SSE connection, not a reason to drop
      // the event for everyone else.
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (error) {
          console.error('[events] subscriber threw', error)
        }
      }
      return true
    },

    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) options.onActivity?.(true)

      let live = true
      return () => {
        if (!live) return
        live = false
        listeners.delete(listener)
        if (listeners.size === 0) options.onActivity?.(false)
      }
    },

    get subscribers() {
      return listeners.size
    },
  }
}

/** Key both producers agree on, so whichever sees it first wins. */
export const deploymentFinishedKey = (deploymentUuid: string): string =>
  `deployment-finished:${deploymentUuid}`
