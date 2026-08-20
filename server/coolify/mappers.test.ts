import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type * as Api from '../../shared/coolify-api'
import {
  buildInsights,
  buildKpis,
  buildPaletteActions,
  buildTimeline,
  createLinks,
  DAY_MS,
  deriveSystemStatus,
  DOWN_AFTER_FAILURES,
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
  type ProbeHealth,
  type ServerHealth,
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
  const links = createLinks('https://coolify.test', new Map([[7, { projectUuid: 'p1', environmentUuid: 'e1' }]]))
  const healthyServer: ServerHealth = {
    server: mapServer({ uuid: 's1', name: 'localhost', ip: '10.0.0.1', is_reachable: true }),
    diskAlert: false,
    diskPct: null,
    unreachableCount: 0,
    metricsExpected: false,
  }
  const healthy = { uuid: 'a1', name: 'api', status: parseResourceStatus('running:healthy'), environmentId: 7 }

  const base = {
    servers: [healthyServer],
    applications: [healthy],
    probes: [],
    recentFailures: [],
    backupFailures: [],
    links,
    now: NOW,
  }

  const probe = (over: Partial<ProbeHealth> = {}): ProbeHealth => ({
    uuid: 'a1',
    name: 'api',
    host: 'api.test',
    environmentId: 7,
    up: true,
    consecutiveFailures: 0,
    uptimePct: 100,
    samples: 1440,
    tls: null,
    ...over,
  })

  it('reports an all-clear rather than an empty column', () => {
    const insights = buildInsights(base)
    assert.equal(insights.length, 1)
    assert.equal(insights[0]?.severity, 'ok')
  })

  it('raises unreachable servers first', () => {
    const insights = buildInsights({
      ...base,
      servers: [{ ...healthyServer, server: { ...healthyServer.server, reachable: false }, unreachableCount: 4 }],
      applications: [{ ...healthy, status: parseResourceStatus('exited:unhealthy') }],
    })
    assert.equal(insights[0]?.severity, 'err')
    assert.match(insights[0]?.title ?? '', /unreachable/)
    assert.match(insights[0]?.description ?? '', /4 times/)
    assert.equal(insights[0]?.href, 'https://coolify.test/server/s1')
  })

  it('groups repeated failures of one app into a single insight', () => {
    const insights = buildInsights({
      ...base,
      recentFailures: [
        { app: 'api', at: NOW - 60_000 },
        { app: 'api', at: NOW - 120_000 },
        { app: 'api', at: NOW - 180_000 },
      ],
    })
    assert.equal(insights.length, 1)
    assert.match(insights[0]?.title ?? '', /3 failed deployments on api/)
    assert.equal(
      insights[0]?.href,
      'https://coolify.test/project/p1/environment/e1/application/a1/deployment',
    )
  })

  it('distinguishes a running-but-unhealthy app from a stopped one', () => {
    const insights = buildInsights({
      ...base,
      applications: [{ ...healthy, status: parseResourceStatus('running:unhealthy') }],
    })
    assert.equal(insights[0]?.severity, 'warn')
    assert.match(insights[0]?.title ?? '', /unhealthy/)
  })

  it('calls an application down only once the probe has failed enough times', () => {
    const twice = buildInsights({ ...base, probes: [probe({ up: false, consecutiveFailures: 2 })] })
    assert.equal(twice[0]?.severity, 'ok')

    const enough = buildInsights({
      ...base,
      probes: [probe({ up: false, consecutiveFailures: DOWN_AFTER_FAILURES })],
    })
    assert.match(enough[0]?.title ?? '', /api is not answering/)
    assert.equal(enough[0]?.href, 'https://coolify.test/project/p1/environment/e1/application/a1')
  })

  it('stays silent about a probe failing on an app Coolify already reports as stopped', () => {
    const insights = buildInsights({
      ...base,
      applications: [{ ...healthy, status: parseResourceStatus('exited:unhealthy') }],
      probes: [probe({ up: false, consecutiveFailures: 9 })],
    })
    assert.equal(insights.length, 1)
    assert.match(insights[0]?.title ?? '', /api is exited/)
  })

  it('warns before a certificate expires and escalates once it has', () => {
    const soon = buildInsights({
      ...base,
      probes: [probe({ tls: { daysLeft: 9, trusted: true, error: null } })],
    })
    assert.equal(soon[0]?.severity, 'warn')
    assert.match(soon[0]?.title ?? '', /expires in 9 d/)
    assert.equal(soon[0]?.href, 'https://coolify.test/project/p1/environment/e1/application/a1/domains')

    const expired = buildInsights({
      ...base,
      probes: [probe({ tls: { daysLeft: -2, trusted: false, error: null } })],
    })
    assert.equal(expired[0]?.severity, 'err')
    assert.match(expired[0]?.description ?? '', /expired 2 d ago/)
  })

  it('ignores a healthy certificate', () => {
    const insights = buildInsights({
      ...base,
      probes: [probe({ tls: { daysLeft: 60, trusted: true, error: null } })],
    })
    assert.equal(insights[0]?.severity, 'ok')
  })

  it('reports a failed backup with a link to its database', () => {
    const insights = buildInsights({
      ...base,
      backupFailures: [{ database: 'postgres', databaseUuid: 'db1', environmentId: 7, at: NOW - 3_600_000 }],
    })
    assert.equal(insights[0]?.severity, 'err')
    assert.match(insights[0]?.title ?? '', /Backup of postgres failed/)
    assert.equal(insights[0]?.href, 'https://coolify.test/project/p1/environment/e1/database/db1/backups')
  })

  it('turns a disk alert into an insight, with the webhook figure when it has one', () => {
    const known = buildInsights({ ...base, servers: [{ ...healthyServer, diskAlert: true, diskPct: 93 }] })
    assert.equal(known[0]?.severity, 'err')
    assert.match(known[0]?.title ?? '', /disk at 93 %/)

    const unknown = buildInsights({ ...base, servers: [{ ...healthyServer, diskAlert: true }] })
    assert.equal(unknown[0]?.severity, 'warn')
    assert.match(unknown[0]?.title ?? '', /low on disk space/)
  })

  it('flags degraded uptime only for an application that is currently up', () => {
    const degraded = buildInsights({ ...base, probes: [probe({ uptimePct: 98.2, samples: 900 })] })
    assert.equal(degraded[0]?.severity, 'warn')
    assert.match(degraded[0]?.title ?? '', /98.20 %/)

    // Down right now: the outage is the insight, not the average it produced.
    const down = buildInsights({
      ...base,
      probes: [probe({ uptimePct: 98.2, up: false, consecutiveFailures: 5 })],
    })
    assert.equal(down.length, 1)
    assert.match(down[0]?.title ?? '', /not answering/)
  })

  it('says nothing about uptime before there are enough samples', () => {
    const insights = buildInsights({ ...base, probes: [probe({ uptimePct: null, samples: 2 })] })
    assert.equal(insights[0]?.severity, 'ok')
  })

  it('stays quiet about metrics nobody asked this dashboard to collect', () => {
    // A default install has no SSH key, so every CPU gauge is empty by design.
    // Turning that into an alert would make the panel cry wolf on every screen.
    const insights = buildInsights({ ...base, servers: [{ ...healthyServer, metricsExpected: false }] })
    assert.equal(insights[0]?.severity, 'ok')
  })

  it('reports metrics the operator configured and is not getting', () => {
    const server = mapServer(
      { uuid: 's1', name: 'localhost', is_reachable: true },
      { source: 'sentinel-off', note: 'Sentinel metrics are disabled on this server.' },
    )
    const insights = buildInsights({
      ...base,
      servers: [{ ...healthyServer, server, metricsExpected: true }],
    })
    assert.equal(insights[0]?.severity, 'warn')
    assert.equal(insights[0]?.title, 'Sentinel metrics are off on localhost')
    assert.equal(insights[0]?.href, 'https://coolify.test/server/s1')
  })

  it('leaves an unreachable server one insight, not two', () => {
    // "Cannot SSH in" already says why the gauges are empty.
    const server = mapServer(
      { uuid: 's1', name: 'localhost', is_reachable: false },
      { source: 'error', note: 'Coolify cannot reach this server.' },
    )
    const insights = buildInsights({
      ...base,
      servers: [{ ...healthyServer, server, metricsExpected: true }],
    })
    assert.equal(insights.length, 1)
    assert.equal(insights[0]?.severity, 'err')
    assert.match(insights[0]?.title ?? '', /unreachable/)
  })

  it('sorts errors above warnings and counts what it had to hide', () => {
    const insights = buildInsights({
      ...base,
      applications: [
        { uuid: 'a1', name: 'api', status: parseResourceStatus('running:unhealthy'), environmentId: 7 },
        { uuid: 'a2', name: 'web', status: parseResourceStatus('exited:unhealthy'), environmentId: 7 },
      ],
      servers: [
        { ...healthyServer, server: { ...healthyServer.server, reachable: false } },
        { ...healthyServer, diskAlert: true, diskPct: 95 },
      ],
      backupFailures: [{ database: 'pg', databaseUuid: 'db1', environmentId: 7, at: NOW }],
      recentFailures: [{ app: 'api', at: NOW }],
    })

    // Six rules fired: four errors, then the unhealthy app and its failed
    // deployment. The last slot is the count of what did not fit, and it wears
    // the severity of the worst thing it is hiding.
    assert.equal(insights.length, 5)
    assert.deepEqual(
      insights.map(insight => insight.severity),
      ['err', 'err', 'err', 'err', 'warn'],
    )
    assert.equal(insights.at(-1)?.id, 'more-insights')
    assert.match(insights.at(-1)?.title ?? '', /2 more issues need attention/)
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
    assert.equal(server.metrics.cpu, null)
    assert.equal(server.metrics.mem, null)
    assert.equal(server.metrics.dsk, null)
    assert.equal(server.pingMs, null)
    assert.equal(server.region, '10.0.0.1')
  })

  it('says which silence an empty gauge is, rather than only that it is empty', () => {
    const server = mapServer({ uuid: 's', name: 'n' })
    assert.equal(server.metrics.source, 'off')
    assert.match(server.metrics.note, /metrics source/i)
  })

  it('shows Sentinel percentages only when they were actually measured', () => {
    const measured = mapServer(
      { uuid: 's', name: 'n' },
      { cpu: 41.2, mem: 68, source: 'sentinel', note: 'Measured by Sentinel on n, 3 s ago.' },
    )
    assert.equal(measured.metrics.cpu, 41.2)
    assert.equal(measured.metrics.mem, 68)

    // A stale reading keeps its numbers out of the UI: an old percentage shown
    // as current is exactly the kind of plausible lie the panel must not tell.
    const stale = mapServer({ uuid: 's', name: 'n' }, { cpu: 41.2, mem: 68, source: 'stale', note: 'too old' })
    assert.equal(stale.metrics.cpu, null)
    assert.equal(stale.metrics.mem, null)
    assert.equal(stale.metrics.note, 'too old')
  })

  it('keeps disk tied to the alert that carried the figure', () => {
    const alerting = mapServer(
      { uuid: 's', name: 'n', high_disk_usage_notification_sent: true },
      { diskPct: 93 },
    )
    assert.equal(alerting.metrics.dsk, 93)
    // No alert standing: the last known percentage is not a current one.
    assert.equal(mapServer({ uuid: 's', name: 'n' }, { diskPct: 93 }).metrics.dsk, null)
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
