/**
 * The first-run diagnostic (phase 7 of docs/roadmap.md).
 *
 * Everything this reports could be worked out by reading the documentation and
 * three `curl` commands. The point is that nobody should have to: a token with
 * the wrong abilities, an instance whose API is switched off, an IP that is not
 * allowlisted and a revoked token all look identical from the dashboard — a
 * panel that will not load — and they have four different fixes.
 *
 * Two rules shaped it:
 *
 *  1. **Nothing here changes anything.** Every probe is a read, including the
 *     ability checks: Coolify keeps a GET beside each action route whose only
 *     job is to say "this moved to POST", and those GETs sit behind the same
 *     ability middleware as the action itself (see `client.abilityProbe`).
 *  2. **A check that cannot be run says so.** `unknown` is a real answer, and a
 *     more honest one than a green tick inferred from something else.
 */

import type { SetupCheck, SetupReport } from '../shared/bff'
import type { CoolifyClient } from './coolify/client'
import { CoolifyError } from './coolify/client'
import type { BffConfig } from './config'

export type { SetupCheck, SetupReport } from '../shared/bff'

export interface SetupDeps {
  config: BffConfig
  /** null when `COOLIFY_URL` / `COOLIFY_TOKEN` are missing */
  client: CoolifyClient | null
  /** `'sqlite'` or the in-memory fallback */
  storeKind: string
  /** true when a `DASHBOARD_PASSWORD` is set */
  passwordSet: boolean
  now?: () => number
}

const ok = (id: string, title: string, detail: string): SetupCheck => ({ id, title, status: 'ok', detail })

/** Coolify's own pages, so a finding is one click from where it gets fixed. */
const pages = (base: string | null) => ({
  tokens: base ? `${base}/security/api-tokens` : undefined,
  advanced: base ? `${base}/settings/advanced` : undefined,
  root: base ?? undefined,
})

/**
 * Turns an upstream failure into the check that explains it. The four `403`
 * flavours are the whole reason this exists: Coolify says the same status for
 * a missing ability, a member-level owner, a disabled API and a blocked IP.
 */
function explainUpstream(error: unknown, link: ReturnType<typeof pages>): { detail: string; hint: string; link?: string } {
  if (!(error instanceof CoolifyError)) {
    return { detail: error instanceof Error ? error.message : String(error), hint: 'Unexpected — please open an issue.' }
  }
  switch (error.code) {
    case 'unreachable':
      return {
        detail: error.message,
        hint: 'Check COOLIFY_URL, that the instance is up, and that this host can route to it. A container on the same box still needs the public URL unless you put it on the same Docker network.',
      }
    case 'unauthorized':
      return {
        detail: 'Coolify rejected the token (it answers 400 "Invalid token.", not 401).',
        hint: 'The token is wrong or was revoked — create a new one and set COOLIFY_TOKEN.',
        ...(link.tokens ? { link: link.tokens } : {}),
      }
    case 'api_disabled':
      return {
        detail: 'The API is switched off on this instance.',
        hint: 'Enable it under Settings → Advanced → API Access.',
        ...(link.advanced ? { link: link.advanced } : {}),
      }
    case 'ip_blocked':
      return {
        detail: "This host's IP is not in the instance's API allowlist.",
        hint: 'Add it under Settings → Advanced, or empty the allowlist to accept every address.',
        ...(link.advanced ? { link: link.advanced } : {}),
      }
    case 'rate_limited':
      return {
        detail: 'Coolify is rate-limiting this token (200 req/min per user).',
        hint: 'Wait a minute and run this again. If it persists, another script is sharing the same user.',
      }
    default:
      return { detail: error.message, hint: 'See docs/troubleshooting.md.' }
  }
}

/** Runs every check, in dependency order, and stops asking once the answer is known. */
export async function runSetupChecks(deps: SetupDeps): Promise<SetupReport> {
  const { config, client } = deps
  const link = pages(config.coolifyUrl)
  const checks: SetupCheck[] = []
  let version: string | null = null
  let team: string | null = null

  /* --- 1. is it configured at all ---------------------------------------- */

  const missing = [
    ...(config.coolifyUrl ? [] : ['COOLIFY_URL']),
    ...(config.coolifyToken ? [] : ['COOLIFY_TOKEN']),
  ]

  if (missing.length > 0 || !client) {
    checks.push({
      id: 'config',
      title: 'Configuration',
      status: 'fail',
      detail: `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.`,
      hint: 'Copy .env.example to .env and fill them in, or pass them as environment variables to the container.',
    })
    // Nothing upstream can be asked without them; the rest would all be `unknown`.
    return report(deps, checks, null, null)
  }

  checks.push(ok('config', 'Configuration', `COOLIFY_URL is ${config.coolifyUrl}, and a token is set.`))

  /* --- 2. does the instance answer, and does it accept the token --------- */

  try {
    version = (await client.version()).trim()
    checks.push(ok('reachable', 'The instance answers', `Coolify ${version} at ${config.coolifyUrl}.`))
  } catch (error) {
    const explained = explainUpstream(error, link)
    checks.push({ id: 'reachable', title: 'The instance answers', status: 'fail', ...explained })
    // `GET /version` needs only `read`; if it failed, everything below fails
    // the same way, and repeating it four times helps nobody.
    return report(deps, checks, null, null)
  }

  checks.push(
    ok('ability-read', 'Ability · read', 'Granted — the dashboard can display everything it shows.'),
  )

  /* --- 3. which team, and how much of it can be seen --------------------- */

  try {
    const current = await client.team()
    team = typeof current.name === 'string' ? current.name : null
    checks.push(ok('team', 'Team', team ? `The token belongs to “${team}”.` : 'The token belongs to a team.'))
  } catch (error) {
    const explained = explainUpstream(error, link)
    checks.push({ id: 'team', title: 'Team', status: 'warn', ...explained })
  }

  /* --- 4. sensitive reads: build logs and the Sentinel token ------------- */

  checks.push(await sensitiveCheck(client, link))

  /* --- 5. the two abilities with a side-effect-free probe ---------------- */

  for (const [ability, title, unlocks] of [
    ['deploy', 'Ability · deploy', 'Deploy, cancel, restart and stop'],
    ['write', 'Ability · write', 'The auto-deploy toggle and running a scheduled task'],
  ] as const) {
    const verdict = await client.abilityProbe(ability)
    checks.push({
      id: `ability-${ability}`,
      title,
      status: verdict.granted ? 'ok' : verdict.reason === 'unavailable' ? 'unknown' : 'warn',
      detail: verdict.granted ? `Granted. ${unlocks} will work.` : verdict.message,
      ...(verdict.granted
        ? {}
        : {
            hint:
              verdict.reason === 'role'
                ? 'The token carries abilities its owner is not allowed to use: it must belong to an admin or owner of the team. Re-create it from such an account.'
                : verdict.reason === 'missing'
                  ? `${unlocks} will report the missing ability instead of working. Tick \`${ability}\` on the token, or leave it off deliberately — the dashboard still renders in full.`
                  : 'Could not be determined; run this again.',
            ...(link.tokens ? { link: link.tokens } : {}),
          }),
    })
  }

  /* --- 6. this deployment's own settings --------------------------------- */

  checks.push(...localChecks(deps))

  return report(deps, checks, version, team)
}

/**
 * `read:sensitive` guards no route — it is a request attribute that controllers
 * consult to decide whether to include a field. So the only honest way to ask
 * is to look at a field it withholds: `sentinel_token` is *absent*, not empty,
 * without it. That needs a server to ask about, which is why this can end in
 * `unknown` rather than in an answer.
 */
async function sensitiveCheck(client: CoolifyClient, link: ReturnType<typeof pages>): Promise<SetupCheck> {
  const base = {
    id: 'ability-read-sensitive',
    title: 'Ability · read:sensitive',
    hint: 'Without it the log ticker stays empty and the CPU/RAM gauges say why. Tick `read:sensitive` on the token — and note that it also requires its owner to be an admin or owner of the team.',
    ...(link.tokens ? { link: link.tokens } : {}),
  }

  try {
    const servers = await client.servers()
    const first = servers[0]
    if (!first?.uuid) {
      return {
        ...base,
        status: 'unknown',
        detail: 'No server to ask about, so this could not be determined.',
        hint: 'Nothing to fix here — this instance simply has no server the token can see.',
      }
    }

    const sentinel = await client.serverSentinel(first.uuid)
    return sentinel.sentinel_token === undefined
      ? { ...base, status: 'warn', detail: 'Not granted: Coolify withheld the Sentinel token, which it only returns with `read:sensitive` and an admin/owner role.' }
      : {
          id: base.id,
          title: base.title,
          status: 'ok',
          detail: 'Granted — deployment logs stream, and the Sentinel token can be read.',
        }
  } catch (error) {
    return {
      ...base,
      status: 'unknown',
      detail: error instanceof Error ? error.message : String(error),
      hint: 'Could not be determined; run this again.',
    }
  }
}

/** What this deployment has switched on. None of these need the instance. */
function localChecks(deps: SetupDeps): SetupCheck[] {
  const { config } = deps
  const loopback = config.host === '127.0.0.1' || config.host === 'localhost' || config.host === '::1'

  return [
    deps.passwordSet
      ? ok('password', 'Dashboard password', 'Set — the dashboard asks for it and keeps a signed session.')
      : {
          id: 'password',
          title: 'Dashboard password',
          status: loopback ? 'warn' : 'fail',
          detail: loopback
            ? `No DASHBOARD_PASSWORD, so every route is open. Bound to ${config.host}, so only this machine can reach it.`
            : `No DASHBOARD_PASSWORD, and bound to ${config.host}: anyone who can reach this port can deploy and stop things.`,
          hint: 'Set DASHBOARD_PASSWORD, or put an authenticating proxy in front and keep this bound to loopback.',
        },

    config.webhookSecret
      ? ok(
          'webhooks',
          'Incoming webhooks',
          'WEBHOOK_SECRET is set. Point Coolify at /app/hooks/coolify?secret=… to get instant updates.',
        )
      : {
          id: 'webhooks',
          title: 'Incoming webhooks',
          status: 'warn',
          detail: 'No WEBHOOK_SECRET, so Coolify cannot push here — updates arrive by polling.',
          hint: `A few seconds slower, never blind. Set one to close the gap (Coolify refuses webhook URLs on private addresses unless the operator allowlisted them).`,
        },

    config.probes.enabled
      ? ok('probes', 'Uptime probes', `Measuring every ${Math.round(config.probes.intervalMs / 1000)}s from this host.`)
      : {
          id: 'probes',
          title: 'Uptime probes',
          status: 'warn',
          detail: 'PROBES_ENABLED is off, so uptime, latency and certificate expiry stay unknown.',
          hint: 'Coolify measures none of these; this loop is their only source.',
        },

    config.metrics.enabled
      ? ok('metrics', 'Server metrics', `Sentinel over SSH, using ${config.metrics.sshKeyPath ?? 'the default SSH identity'}.`)
      : {
          id: 'metrics',
          title: 'Server metrics',
          status: 'warn',
          detail: 'No METRICS_SSH_KEY, so the CPU and RAM gauges stay empty.',
          hint: 'Coolify publishes no metrics endpoint: its own charts SSH in and query Sentinel, and so does this. The gauges say which silence they are showing.',
        },

    deps.storeKind === 'sqlite'
      ? ok('history', 'Measurement history', `Stored in ${deps.config.dataDir}. Back it up, or accept starting from zero.`)
      : {
          id: 'history',
          title: 'Measurement history',
          status: 'warn',
          detail: 'node:sqlite is unavailable, so history lives in memory and is lost on restart.',
          hint: 'The dashboard renders identically; the KPI deltas and the uptime percentage just restart from zero. Node 24 has node:sqlite built in.',
        },
  ]
}

function report(deps: SetupDeps, checks: SetupCheck[], version: string | null, team: string | null): SetupReport {
  const now = deps.now?.() ?? Date.now()
  return {
    generatedAt: new Date(now).toISOString(),
    ok: checks.every(check => check.status !== 'fail'),
    coolifyUrl: deps.config.coolifyUrl,
    version,
    team,
    checks,
  }
}
