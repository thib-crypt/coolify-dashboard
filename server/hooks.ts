/**
 * Receiver for Coolify's outgoing webhooks (phase 3 of docs/roadmap.md).
 *
 * This is the only genuine *push* Coolify offers a third party, and it comes
 * with three constraints that shape everything below:
 *
 *  1. **The payloads are not signed.** `SendWebhookJob` posts the body and
 *     nothing else — no HMAC, no timestamp, no delivery id. Authentication is
 *     therefore a secret in the receiver URL, compared in constant time.
 *  2. **Coolify retries up to five times** (`SendWebhookJob::$tries = 5`,
 *     `$backoff = 10`) and, with no delivery id, a retry is byte-identical to a
 *     new event. Every interpretation carries a dedupe key so a retry is dropped
 *     instead of toasting five times.
 *  3. **Coolify blocks private targets.** `SafeWebhookUrl` refuses loopback,
 *     link-local and private ranges unless the instance operator allowlisted
 *     them, so the BFF has to be reachable at a public URL for this to work at
 *     all. When it is not, the poller (`poller.ts`) is the fallback — the
 *     dashboard is a few seconds slower, never blind.
 *
 * `interpretWebhook` is pure: given a payload it says what to drop from the
 * cache and what to push. The route does the I/O.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { LiveEvent, ToastTone } from '../shared/bff'
import type * as Api from '../shared/coolify-api'
import { deploymentFinishedKey } from './events'
import type { Signal } from './signals'

export interface WebhookEffect {
  /** cache key prefixes to drop, so the next `/app/overview` re-reads upstream */
  invalidate: string[]
  /** what to announce, each with the key that makes a Coolify retry a no-op */
  events: Array<{ event: LiveEvent; key: string }>
  /**
   * The nudge that makes every connected browser refetch. Kept apart from
   * `events` because it must **not** fire on a retry: it is the same "something
   * moved" for the fifth delivery as for the first, and re-sending it would cost
   * one `/app/overview` per open tab per retry. The route publishes it only when
   * the payload actually announced something new — or when it announced nothing
   * dedupable at all, as a silent backup success does.
   */
  refresh: LiveEvent
  /** true when the event may have changed which deployments are running */
  pokePoller: boolean
  /**
   * Readings the REST API does not expose, to be remembered until they expire
   * (`signals.ts`). Recorded on every delivery, retry included: writing the same
   * value twice is harmless, and dropping it would lose the figure whenever the
   * first attempt was the one that failed.
   */
  signals: Signal[]
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** Coolify's own `message` is generic ("Deployment failed"); the resource is not. */
function subject(payload: Api.CoolifyWebhookPayload): string | null {
  return (
    nonEmpty(payload.application_name) ??
    nonEmpty(payload.database_name) ??
    nonEmpty(payload.task_name) ??
    nonEmpty(payload.server_name) ??
    nonEmpty(payload.container_name)
  )
}

/**
 * Translates one webhook into cache invalidations and pushed events.
 *
 * Successes that the dashboard already shows on its own are deliberately silent:
 * a nightly backup succeeding is not worth a toast, and the `overview-changed`
 * it triggers is enough for the panel to catch up. Failures always speak.
 */
export function interpretWebhook(payload: Api.CoolifyWebhookPayload, at: string): WebhookEffect {
  const event = nonEmpty(payload.event) ?? 'unknown'
  const who = subject(payload)
  const deploymentUuid = nonEmpty(payload.deployment_uuid)

  const effect: WebhookEffect = {
    invalidate: [],
    events: [],
    refresh: { type: 'overview-changed', at, reason: `webhook ${event}` },
    pokePoller: false,
    signals: [],
  }
  const toast = (message: string, tone: ToastTone, key: string) => {
    effect.events.push({ event: { type: 'toast', at, message, tone }, key })
  }

  switch (event) {
    case 'deployment_success':
    case 'deployment_failed': {
      const failed = event === 'deployment_failed'
      effect.invalidate.push('deployments')
      effect.pokePoller = true
      if (deploymentUuid) {
        effect.events.push({
          event: {
            type: 'deployment-finished',
            at,
            deploymentId: deploymentUuid,
            app: who ?? 'an application',
            state: failed ? 'failed' : 'success',
            message: failed
              ? `${who ?? 'An application'} — deployment failed`
              : `${who ?? 'An application'} deployed`,
          },
          key: deploymentFinishedKey(deploymentUuid),
        })
      } else {
        // No uuid to key on: fall back to a plain toast keyed by resource.
        toast(
          failed ? `${who ?? 'An application'} — deployment failed` : `${who ?? 'An application'} deployed`,
          failed ? 'err' : 'ok',
          `deployment:${event}:${who ?? 'unknown'}`,
        )
      }
      break
    }

    case 'status_changed':
    case 'container_stopped':
      effect.invalidate.push('applications', 'application:')
      toast(`${who ?? 'A resource'} stopped`, 'warn', `${event}:${who ?? 'unknown'}`)
      break

    case 'container_restarted':
      effect.invalidate.push('applications', 'application:')
      toast(`${who ?? 'A resource'} was restarted automatically`, 'info', `${event}:${who ?? 'unknown'}`)
      break

    case 'server_unreachable':
      effect.invalidate.push('servers')
      toast(`${who ?? 'A server'} is unreachable`, 'err', `${event}:${who ?? 'unknown'}`)
      break

    case 'server_reachable':
      effect.invalidate.push('servers')
      toast(`${who ?? 'A server'} is back`, 'ok', `${event}:${who ?? 'unknown'}`)
      break

    case 'high_disk_usage': {
      effect.invalidate.push('servers')
      const usage = typeof payload.disk_usage === 'number' ? ` — disk at ${payload.disk_usage} %` : ''
      // The only place this number ever appears: keep it for the Fleet gauge
      // and the insight, both of which outlive the toast.
      if (typeof payload.disk_usage === 'number' && who) {
        effect.signals.push({ kind: 'disk_usage', subject: who, value: payload.disk_usage, at: Date.parse(at) })
      }
      toast(`${who ?? 'A server'} is running out of space${usage}`, 'warn', `${event}:${who ?? 'unknown'}`)
      break
    }

    case 'backup_failed':
      effect.invalidate.push('databases', 'backups')
      toast(`Backup of ${who ?? 'a database'} failed`, 'err', `${event}:${who ?? 'unknown'}`)
      break

    case 'backup_success':
    case 'backup_success_with_s3_warning':
      // Silent on purpose: the KPI and the timeline show it, a toast would not.
      effect.invalidate.push('databases', 'backups')
      break

    case 'task_failed':
      toast(who ? `Scheduled task ${who} failed` : 'A scheduled task failed', 'err', `${event}:${who ?? 'unknown'}`)
      break

    case 'task_success':
      break

    case 'test':
      toast('Test webhook received — the live channel is wired.', 'ok', 'test')
      break

    default:
      // Docker cleanup, Traefik version, server patches: nothing the dashboard
      // renders today. Still worth a refresh — Coolify only sends what changed.
      break
  }

  return effect
}

/**
 * Constant-time secret check.
 *
 * `timingSafeEqual` throws on a length mismatch — which would leak the length
 * through the exception itself — so both sides are hashed to a fixed 32 bytes
 * first and the comparison always runs on equal-sized buffers.
 */
export function secretMatches(expected: string, received: string | undefined): boolean {
  if (!expected || !received) return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(expected), digest(received))
}
