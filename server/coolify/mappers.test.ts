import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type * as Api from '../../shared/coolify-api'
import {
  buildInsights,
  buildKpis,
  buildPaletteActions,
  buildTimeline,
  DAY_MS,
  deriveSystemStatus,
  describeFrequency,
  displayDomain,
  formatDuration,
  formatRelative,
  gradientFor,
  initialOf,
  mapDeployment,
  mapDeploymentState,
  mapServer,
  median,
  nextCronRun,
  parseApiDate,
  parseDeploymentLogs,
  parseResourceStatus,
  primaryFqdn,
  sparkFrom,
  summarizeDeployments,
  type KpiInput,
} from './mappers'

const NOW = Date.parse('2026-08-18T14:32:00Z')

describe('parseApiDate', () => {
  it('reads ISO timestamps with microseconds', () => {
    assert.equal(parseApiDate('2026-08-12T07:46:45.000000Z'), Date.parse('2026-08-12T07:46:45Z'))
  })

  it('treats bare SQL datetimes as UTC, not local time', () => {
    // Coolify stores UTC; `Date.parse` would read this as local and skew durations.
    assert.equal(parseApiDate('2026-08-17 12:02:06'), Date.parse('2026-08-17T12:02:06Z'))
  })

  it('returns null for empty or unparseable input', () => {
    assert.equal(parseApiDate(null), null)
    assert.equal(parseApiDate(''), null)
    assert.equal(parseApiDate('   '), null)
    assert.equal(parseApiDate('not a date'), null)
  })
})

describe('parseResourceStatus', () => {
  it('splits Coolify\'s "<state>:<health>" form', () => {
    assert.deepEqual(parseResourceStatus('running:healthy'), { state: 'running', health: 'healthy' })
    assert.deepEqual(parseResourceStatus('running:unknown'), { state: 'running', health: 'unknown' })
    assert.deepEqual(parseResourceStatus('exited:unhealthy'), { state: 'exited', health: 'unhealthy' })
  })

  it('defaults the health half when it is missing', () => {
    assert.deepEqual(parseResourceStatus('running'), { state: 'running', health: 'unknown' })
    assert.deepEqual(parseResourceStatus(undefined), { state: 'unknown', health: 'unknown' })
  })
})

describe('domains', () => {
  it('takes the first of a comma-separated fqdn list', () => {
    assert.equal(primaryFqdn('https://a.dev, https://b.dev'), 'https://a.dev')
  })

  it('strips the scheme and trailing slash for display', () => {
    assert.equal(displayDomain('https://tehillah.orbitdigital.cloud/api'), 'tehillah.orbitdigital.cloud/api')
    assert.equal(displayDomain('https://orbit.dev/'), 'orbit.dev')
  })

  it('says so when an application has no public domain', () => {
    assert.equal(displayDomain(null), 'internal · no public domain')
    assert.equal(displayDomain(''), 'internal · no public domain')
  })
})

describe('cosmetics', () => {
  it('picks the first alphanumeric character as the tile initial', () => {
    assert.equal(initialOf('apprendrepython:ai-proxy'), 'A')
    assert.equal(initialOf('-worker'), 'W')
    assert.equal(initialOf(''), '?')
  })

  it('gives the same application the same gradient every time', () => {
    assert.equal(gradientFor('abp7l1zsnx5dfmeugfn4c3m3'), gradientFor('abp7l1zsnx5dfmeugfn4c3m3'))
    assert.match(gradientFor('anything'), /^linear-gradient/)
  })
})

describe('formatting', () => {
  it('formats durations like the mockup', () => {
    assert.equal(formatDuration(58_000), '58s')
    assert.equal(formatDuration(102_000), '1m 42s')
    assert.equal(formatDuration(125_000), '2m 05s')
    assert.equal(formatDuration(3_900_000), '1h 05m')
  })

  it('formats relative times', () => {
    assert.equal(formatRelative(NOW - 30_000, NOW), 'just now')
    assert.equal(formatRelative(NOW - 12 * 60_000, NOW), '12 min ago')
    assert.equal(formatRelative(NOW - 3 * 3_600_000, NOW), '3 h ago')
    assert.equal(formatRelative(NOW - 30 * 3_600_000, NOW), 'yesterday')
    assert.equal(formatRelative(NOW - 3 * DAY_MS, NOW), '3 d ago')
  })
})

describe('deployment states', () => {
  it('maps every status of the ApplicationDeploymentStatus enum', () => {
    assert.equal(mapDeploymentState('queued'), 'running')
    assert.equal(mapDeploymentState('in_progress'), 'running')
    assert.equal(mapDeploymentState('finished'), 'success')
    assert.equal(mapDeploymentState('failed'), 'failed')
    assert.equal(mapDeploymentState('cancelled-by-user'), 'cancelled')
  })

  it('never reports an unknown status as a success', () => {
    assert.equal(mapDeploymentState('something-new'), 'failed')
    assert.equal(mapDeploymentState(undefined), 'failed')
  })
})

describe('parseDeploymentLogs', () => {
  const logs = JSON.stringify([
    { command: null, output: 'second', type: 'stdout', timestamp: '', hidden: false, batch: 1, order: 2 },
    { command: null, output: 'first', type: 'stdout', timestamp: '', hidden: false, batch: 1, order: 1 },
    { command: null, output: 'noise', type: 'stdout', timestamp: '', hidden: true, batch: 1, order: 3 },
  ])

  it('parses the JSON string, sorts by order and drops hidden lines', () => {
    assert.deepEqual(parseDeploymentLogs(logs), ['▸ first', '▸ second'])
  })

  it('falls back to the command when there is no output', () => {
    const payload = JSON.stringify([
      { command: 'docker build .', output: '', type: 'stdout', timestamp: '', hidden: false, batch: 1, order: 1 },
    ])
    assert.deepEqual(parseDeploymentLogs(payload), ['▸ docker build .'])
  })

  it('returns nothing rather than throwing on absent or malformed logs', () => {
    // `logs` is hidden unless the token has read:sensitive and an admin role.
    assert.deepEqual(parseDeploymentLogs(null), [])
    assert.deepEqual(parseDeploymentLogs('not json'), [])
    assert.deepEqual(parseDeploymentLogs('{"not":"an array"}'), [])
  })
})

describe('mapDeployment', () => {
  const finished: Api.ApplicationDeploymentQueue = {
    deployment_uuid: 'dep-1',
    application_name: 'tehillah-api',
    status: 'finished',
    commit: 'a1f4c92abcdef',
    commit_message: 'fix: cache invalidation',
    created_at: '2026-08-18T14:00:00.000000Z',
    finished_at: '2026-08-18T14:01:42.000000Z',
  }

  it('derives duration from finished_at − created_at (there is no started_at)', () => {
    const mapped = mapDeployment(finished, { branch: 'main' }, NOW)
    assert.equal(mapped.state, 'success')
    assert.equal(mapped.duration, '1m 42s')
    assert.equal(mapped.when, '30 min ago')
    assert.equal(mapped.sha, 'a1f4c92')
    assert.equal(mapped.app, 'tehillah-api')
    assert.equal(mapped.branch, 'main')
  })

  it('reports elapsed seconds for a running deployment', () => {
    const mapped = mapDeployment(
      { ...finished, status: 'in_progress', finished_at: null },
      { branch: 'main' },
      NOW,
    )
    assert.equal(mapped.state, 'running')
    assert.equal(mapped.elapsedSeconds, 32 * 60)
    assert.equal(mapped.duration, undefined)
  })

  it('falls back visibly when fields are missing', () => {
    const mapped = mapDeployment(
      { deployment_uuid: 'dep-2', status: 'failed' },
      {},
      NOW,
    )
    assert.equal(mapped.app, 'unknown')
    assert.equal(mapped.message, 'no commit message')
    assert.equal(mapped.branch, '—')
    assert.equal(mapped.sha, '—')
  })
})

describe('summarizeDeployments', () => {
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

  const history: Api.ApplicationDeploymentQueue[] = [
    { deployment_uuid: '1', status: 'finished', created_at: at(60), finished_at: at(59) },
    { deployment_uuid: '2', status: 'finished', created_at: at(120), finished_at: at(117) },
    { deployment_uuid: '3', status: 'failed', created_at: at(180), finished_at: at(179) },
    // outside the 24 h window
    { deployment_uuid: '4', status: 'finished', created_at: at(60 * 30), finished_at: at(60 * 30 - 1) },
  ]

  it('counts only the last 24 hours', () => {
    const stats = summarizeDeployments(history, NOW)
    assert.equal(stats.total, 3)
    assert.equal(stats.success, 2)
    assert.equal(stats.failed, 1)
  })

  it('computes the success rate and median duration of successes', () => {
    const stats = summarizeDeployments(history, NOW)
    assert.equal(Math.round(stats.successPct ?? 0), 67)
    assert.equal(stats.medianDurationMs, 120_000) // median of 60 s and 180 s
  })

  it('reports null rather than 0 % when nothing ran', () => {
    const stats = summarizeDeployments([], NOW)
    assert.equal(stats.total, 0)
    assert.equal(stats.successPct, null)
    assert.equal(stats.medianDurationMs, null)
  })
})

describe('median', () => {
  it('averages the two middle values on even-sized input', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5)
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([]), null)
  })
})

describe('sparkFrom', () => {
  it('maps the highest value to the smallest y (SVG y grows downward)', () => {
    const points = sparkFrom([1, 5, 3])
    assert.equal(points.length, 3)
    assert.deepEqual(points[0], [0, 26])
    assert.deepEqual(points[1], [42, 4])
    assert.equal(points[2]?.[0], 84)
  })

  it('draws a flat line when there is nothing to compare', () => {
    assert.deepEqual(sparkFrom([]), [[0, 15], [84, 15]])
    assert.deepEqual(sparkFrom([7]), [[0, 15], [84, 15]])
    assert.deepEqual(sparkFrom([4, 4, 4]).map(p => p[1]), [15, 15, 15])
  })

  it('keeps at most the last N readings', () => {
    assert.equal(sparkFrom(Array.from({ length: 100 }, (_, i) => i), 12).length, 12)
  })
})

describe('buildKpis', () => {
  const input: KpiInput = {
    applicationCount: 8,
    applicationsWeekAgo: 6,
    deployments: { total: 12, success: 11, failed: 1, successPct: 91.6, medianDurationMs: 102_000 },
    previousMedianDeployMs: 114_000,
    backups: { total: 3, failed: 0 },
    series: { applications: [6, 7, 8], deployments: [4, 9, 12], medianDeployMs: [114_000, 102_000], backups: [3, 3] },
  }

  it('builds the four cards the grid expects', () => {
    const kpis = buildKpis(input)
    assert.deepEqual(kpis.map(k => k.id), ['apps', 'deployments', 'deploy-duration', 'backups'])
  })

  it('turns the snapshot delta into the applications badge', () => {
    const [apps] = buildKpis(input)
    assert.equal(apps?.value, '8')
    assert.deepEqual(apps?.badge, { text: '+2', trend: 'ok', caret: true })
    assert.equal(apps?.sub, '2 added this week')
  })

  it('flags a poor deployment success rate', () => {
    const kpis = buildKpis({ ...input, deployments: { ...input.deployments, successPct: 60 } })
    assert.equal(kpis[1]?.badge.trend, 'err')
  })

  it('shows an em dash instead of inventing a duration', () => {
    const kpis = buildKpis({
      ...input,
      deployments: { total: 0, success: 0, failed: 0, successPct: null, medianDurationMs: null },
    })
    assert.equal(kpis[2]?.value, '—')
    assert.equal(kpis[2]?.badge.text, 'no data')
    assert.equal(kpis[1]?.badge.text, 'quiet')
  })

  it('marks a faster median as an improvement', () => {
    const kpis = buildKpis(input)
    assert.equal(kpis[2]?.badge.text, '−12 s')
    assert.equal(kpis[2]?.badge.trend, 'ok')
  })

  it('says so when there is no history yet', () => {
    const kpis = buildKpis({ ...input, applicationsWeekAgo: null })
    assert.equal(kpis[0]?.badge.text, 'no history')
    assert.equal(kpis[0]?.sub, 'collecting history')
  })

  it('shows an em dash when no database has a backup schedule', () => {
    const kpis = buildKpis({ ...input, backups: null })
    assert.equal(kpis[3]?.value, '—')
  })
})

describe('cron', () => {
  it('resolves Coolify\'s aliases', () => {
    const from = Date.parse('2026-08-18T14:32:00Z')
    assert.equal(nextCronRun('daily', from), nextCronRun('0 0 * * *', from))
    assert.equal(nextCronRun('@hourly', from), nextCronRun('0 * * * *', from))
  })

  it('returns the next occurrence strictly after `from`', () => {
    const from = Date.parse('2026-08-18T14:32:00Z')
    const next = nextCronRun('0 * * * *', from)
    assert.ok(next !== null && next > from)
    assert.ok(next - from <= 60 * 60_000)
  })

  it('returns null for a broken expression instead of throwing', () => {
    assert.equal(nextCronRun('not a cron', NOW), null)
    assert.equal(nextCronRun('', NOW), null)
  })

  it('describes a schedule in words', () => {
    assert.equal(describeFrequency('0 2 * * *'), '02:00 · every day')
    assert.equal(describeFrequency('daily'), '00:00 · every day')
    assert.equal(describeFrequency('30 3 * * 1'), '03:30 · weekly')
    assert.equal(describeFrequency('0 * * * *'), 'every hour')
  })
})

describe('buildTimeline', () => {
  const now = new Date('2026-08-18T14:32:00').getTime() // local, like the strip

  it('pins now at 2 % and spaces the ticks every six hours', () => {
    const timeline = buildTimeline(now, [])
    assert.equal(timeline.now.left, 2)
    assert.equal(timeline.now.label, 'now · 14:32')
    assert.deepEqual(timeline.ticks.map(t => t.label), ['18:00', '00:00', '06:00', '12:00'])
    assert.equal(timeline.ticks[0]?.left, 14.4)
  })

  it('places jobs by their distance from now', () => {
    const at = now + 12 * 3_600_000
    const timeline = buildTimeline(now, [{ id: 'j', title: 'Backup', detail: '02:00', at }])
    assert.equal(timeline.jobs[0]?.left, 50)
  })

  it('drops jobs outside the 24 h window', () => {
    const timeline = buildTimeline(now, [
      { id: 'past', title: 'a', detail: '', at: now - 60_000 },
      { id: 'far', title: 'b', detail: '', at: now + 2 * DAY_MS },
    ])
    assert.deepEqual(timeline.jobs, [])
  })
})

describe('buildInsights', () => {
  const server = mapServer({ uuid: 's1', name: 'localhost', ip: '10.0.0.1', is_reachable: true })
  const healthy = { uuid: 'a1', name: 'api', status: parseResourceStatus('running:healthy') }

  it('reports an all-clear rather than an empty column', () => {
    const insights = buildInsights({ servers: [server], applications: [healthy], recentFailures: [], now: NOW })
    assert.equal(insights.length, 1)
    assert.equal(insights[0]?.severity, 'ok')
  })

  it('raises unreachable servers first', () => {
    const insights = buildInsights({
      servers: [{ ...server, reachable: false }],
      applications: [{ uuid: 'a1', name: 'api', status: parseResourceStatus('exited:unhealthy') }],
      recentFailures: [],
      now: NOW,
    })
    assert.equal(insights[0]?.severity, 'err')
    assert.match(insights[0]?.title ?? '', /unreachable/)
  })

  it('groups repeated failures of one app into a single insight', () => {
    const insights = buildInsights({
      servers: [server],
      applications: [healthy],
      recentFailures: [
        { app: 'api', at: NOW - 60_000 },
        { app: 'api', at: NOW - 120_000 },
        { app: 'api', at: NOW - 180_000 },
      ],
      now: NOW,
    })
    assert.equal(insights.length, 1)
    assert.match(insights[0]?.title ?? '', /3 failed deployments on api/)
  })

  it('distinguishes a running-but-unhealthy app from a stopped one', () => {
    const insights = buildInsights({
      servers: [server],
      applications: [{ uuid: 'a1', name: 'api', status: parseResourceStatus('running:unhealthy') }],
      recentFailures: [],
      now: NOW,
    })
    assert.equal(insights[0]?.severity, 'warn')
    assert.match(insights[0]?.title ?? '', /unhealthy/)
  })
})

describe('deriveSystemStatus', () => {
  const reachable = mapServer({ uuid: 's1', name: 'a', is_reachable: true })
  const down = mapServer({ uuid: 's2', name: 'b', is_reachable: false })

  it('is green when every server answers and nothing failed', () => {
    assert.deepEqual(deriveSystemStatus([reachable], 0), { ok: true, label: 'All systems operational' })
  })

  it('names the single unreachable server', () => {
    assert.deepEqual(deriveSystemStatus([reachable, down], 0), { ok: false, label: 'b unreachable' })
  })

  it('falls back to recent deployment failures', () => {
    assert.deepEqual(deriveSystemStatus([reachable], 2), {
      ok: false,
      label: '2 failed deployments in the last hour',
    })
  })
})

describe('mapServer', () => {
  it('reads is_reachable from the top level the list endpoint adds', () => {
    assert.equal(mapServer({ uuid: 's', name: 'n', is_reachable: true }).reachable, true)
  })

  it('falls back to settings.is_reachable', () => {
    assert.equal(mapServer({ uuid: 's', name: 'n', settings: { is_reachable: true } }).reachable, true)
  })

  it('leaves metrics and ping null — Coolify exposes neither over REST', () => {
    const server = mapServer({ uuid: 's', name: 'n', ip: '10.0.0.1' })
    assert.deepEqual(server.metrics, { cpu: null, mem: null, dsk: null })
    assert.equal(server.pingMs, null)
    assert.equal(server.region, '10.0.0.1')
  })
})

describe('buildPaletteActions', () => {
  const apps = [
    { id: 'app-1', name: 'api-core', domain: 'api.test', initial: 'A', gradient: '', uptime: null, autoDeploy: true },
    { id: 'app-2', name: 'worker', domain: '', initial: 'W', gradient: '', uptime: null, autoDeploy: null },
  ]

  it('carries an executable command on every entry — the SPA parses no ids', () => {
    const actions = buildPaletteActions(apps)
    assert.deepEqual(
      actions.filter(a => a.title.includes('api-core')).map(a => a.command),
      [
        { kind: 'deploy', application: 'app-1' },
        { kind: 'restart', application: 'app-1' },
        { kind: 'stop', application: 'app-1' },
      ],
    )
    assert.equal(actions.at(-1)?.command.kind, 'ui')
  })

  it('asks for confirmation on the destructive entry, and only that one', () => {
    const confirming = buildPaletteActions(apps).filter(action => action.confirm)
    assert.deepEqual(confirming.map(action => action.command.kind), ['stop', 'stop'])
  })

  it('offers the scheduled tasks it was given, capped', () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      owner: 'application' as const,
      ownerId: 'app-1',
      ownerName: 'api-core',
      taskId: `t${i}`,
      taskName: `task-${i}`,
    }))
    const actions = buildPaletteActions(apps, tasks, { tasks: 2 })
    assert.deepEqual(
      actions.filter(a => a.command.kind === 'run-task').map(a => a.title),
      ['Run task-0 — api-core', 'Run task-1 — api-core'],
    )
  })
})
