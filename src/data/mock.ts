import type { Dashboard, DataSource, EnvironmentName, Server, ServerMetrics } from './types'

/** The mock stands in for a fully-instrumented instance: Sentinel is reading. */
const MOCK_METRICS = { source: 'sentinel', note: 'Sampled locally — the mock has no Sentinel behind it.' } as const

const dashboard: Dashboard = {
  org: 'orbit',
  environment: 'Production',
  environments: ['Production', 'Staging'],
  systemStatus: { ok: true, label: 'All systems operational' },

  kpis: [
    {
      id: 'apps',
      icon: 'apps',
      label: 'Applications',
      badge: { text: '+2', trend: 'ok', caret: true },
      value: '12',
      sub: '2 added this week',
      spark: [[0, 22], [10, 20], [20, 21], [30, 16], [40, 17], [50, 12], [60, 13], [70, 8], [84, 6]],
    },
    {
      id: 'deployments',
      icon: 'deployments',
      label: 'Deployments',
      badge: { text: '97 % ok', trend: 'ok' },
      value: '38',
      sub: 'last 24 hours',
      spark: [[0, 18], [10, 14], [20, 19], [30, 10], [40, 15], [50, 7], [60, 12], [70, 10], [84, 4]],
    },
    {
      id: 'latency',
      icon: 'latency',
      label: 'P95 response',
      badge: { text: '−12 ms', trend: 'ok' },
      value: '184',
      unit: ' ms',
      sub: 'across all edges',
      spark: [[0, 8], [10, 12], [20, 9], [30, 15], [40, 13], [50, 18], [60, 16], [70, 21], [84, 20]],
    },
    {
      id: 'cost',
      icon: 'cost',
      label: 'Monthly cost',
      badge: { text: '+4 %', trend: 'warn' },
      value: '€47',
      unit: '.20',
      sub: '3 servers · Hetzner',
      spark: [[0, 16], [10, 16], [20, 15], [30, 15], [40, 14], [50, 15], [60, 14], [70, 14], [84, 13]],
    },
  ],

  deploymentCount: 38,
  deployments: [
    {
      id: 'dep-live',
      app: 'api-core',
      message: 'fix: cache invalidation on deploy hooks',
      branch: 'main',
      sha: 'a1f4c92',
      state: 'running',
      elapsedSeconds: 47,
      logs: [
        '▸ building image — layer 7/12',
        '▸ npm ci — 412 packages in 8.2s',
        '▸ vite build — 1.94s, 214 modules',
        '▸ pushing image to registry…',
        '▸ healthcheck — waiting for :3000',
        '▸ warming edge cache',
      ],
    },
    {
      id: 'dep-1',
      app: 'web-storefront',
      message: 'feat: product gallery lightbox',
      branch: 'main',
      sha: '9b2e771',
      state: 'success',
      duration: '1m 42s',
      when: '12 min ago',
    },
    {
      id: 'dep-2',
      app: 'docs',
      message: 'chore: bump astro to 5.2',
      branch: 'main',
      sha: 'c44d1e0',
      state: 'success',
      duration: '58s',
      when: '1 h ago',
    },
    {
      id: 'dep-3',
      app: 'worker-queue',
      message: 'fix: retry backoff jitter',
      branch: 'main',
      sha: '77aa3f1',
      state: 'failed',
      duration: '2m 05s',
      when: '3 h ago',
    },
    {
      id: 'dep-4',
      app: 'cdn-edge',
      message: 'perf: brotli level 6 for static assets',
      branch: 'main',
      sha: 'e0b8f24',
      state: 'success',
      duration: '1m 12s',
      when: 'yesterday',
    },
  ],

  servers: [
    { id: 'fsn1', name: 'hetzner-fsn1', region: 'Falkenstein', pingMs: 4, reachable: true, metrics: { cpu: 34, mem: 61, dsk: 42, ...MOCK_METRICS } },
    { id: 'hel1', name: 'hetzner-hel1', region: 'Helsinki', pingMs: 21, reachable: true, metrics: { cpu: 22, mem: 87, dsk: 55, ...MOCK_METRICS } },
    { id: 'ash', name: 'hetzner-ash', region: 'Ashburn', pingMs: 96, reachable: true, metrics: { cpu: 12, mem: 38, dsk: 23, ...MOCK_METRICS } },
  ],
  fleetTotals: [
    { id: 'vcpu', label: 'vCPU total', value: '18' },
    { id: 'memory', label: 'Memory', value: '64 GB' },
    { id: 'storage', label: 'Storage', value: '1.2 TB' },
    { id: 'regions', label: 'Regions', value: '3' },
  ],

  insights: [
    {
      id: 'ins-1',
      severity: 'warn',
      title: 'Memory creep on hetzner-hel1',
      description: 'RSS grew 14 % over 24 h with flat traffic — likely a leak in worker-queue.',
      action: 'Investigate',
    },
    {
      id: 'ins-2',
      severity: 'neutral',
      title: '3 idle preview environments',
      description: 'Untouched for 7+ days across web-storefront — reclaim ≈ 4.2 GB.',
      action: 'Reclaim',
    },
    {
      id: 'ins-3',
      severity: 'ok',
      title: 'Certificate renewal in 12 days',
      description: 'api.orbit.dev — auto-renew is scheduled, nothing to do.',
      action: 'View',
    },
  ],

  applicationCount: 12,
  applications: [
    { id: 'api-core', name: 'api-core', domain: 'api.orbit.dev', initial: 'A', gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)', uptime: '99.98 %', autoDeploy: true },
    { id: 'web-storefront', name: 'web-storefront', domain: 'orbit.dev', initial: 'W', gradient: 'linear-gradient(135deg,#0ea5e9,#22d3ee)', uptime: '100 %', autoDeploy: true },
    { id: 'docs', name: 'docs', domain: 'docs.orbit.dev', initial: 'D', gradient: 'linear-gradient(135deg,#f59e0b,#f97316)', uptime: '99.99 %', autoDeploy: false },
    { id: 'worker-queue', name: 'worker-queue', domain: 'internal · no public domain', initial: 'Q', gradient: 'linear-gradient(135deg,#10b981,#3ecf8e)', uptime: '99.91 %', autoDeploy: true },
  ],

  timeline: {
    now: { left: 2, label: 'now · 14:32' },
    ticks: [
      { left: 14.4, label: '18:00' },
      { left: 39.4, label: '00:00' },
      { left: 64.4, label: '06:00' },
      { left: 89.4, label: '12:00' },
    ],
    jobs: [
      { id: 'job-1', left: 47.7, title: 'Database backup — postgres-main', detail: '02:00 · every day · → S3' },
      { id: 'job-2', left: 54, title: 'Prune unused images', detail: '03:30 · every day · all servers' },
      { id: 'job-3', left: 57.1, title: 'Renew TLS certificates', detail: '04:15 · check daily' },
      { id: 'job-4', left: 77, title: 'Uptime report → Slack', detail: '09:00 · weekdays' },
    ],
  },

  paletteActions: [
    { id: 'deploy:app-api', icon: 'rocket', title: 'Deploy api-core', shortcut: 'D',
      command: { kind: 'deploy', application: 'app-api' } },
    { id: 'restart:app-worker', icon: 'rotate', title: 'Restart worker-queue',
      command: { kind: 'restart', application: 'app-worker' } },
    { id: 'stop:app-api', icon: 'stop', title: 'Stop api-core',
      command: { kind: 'stop', application: 'app-api' }, confirm: 'Confirm — stop api-core' },
    { id: 'task:application:app-api:nightly', icon: 'clock', title: 'Run nightly-sync — api-core',
      command: { kind: 'run-task', owner: 'application', ownerId: 'app-api', task: 'nightly' } },
    { id: 'switch-environment', icon: 'swap', title: 'Switch environment', shortcut: 'E',
      command: { kind: 'ui', target: 'switch-environment' } },
  ],
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

export const mockSource: DataSource = {
  async getDashboard(env: EnvironmentName | null) {
    // structuredClone so live drift never mutates the source of truth
    return { ...structuredClone(dashboard), environment: env ?? dashboard.environment }
  },

  initialTraffic: () => INITIAL_TRAFFIC(),

  sampleTraffic(previous: number) {
    return clamp(previous + (Math.random() - 0.5) * 160, 850, 1600)
  },

  // No live channel: the mock has nothing to push, so the UI keeps looping the
  // canned log lines instead of streaming them.
  subscribe: () => () => {},

  sampleServer(server: Server): ServerMetrics {
    const m = server.metrics
    // the mock always has numbers; the live source has nulls it must not drift
    if (m.cpu === null || m.mem === null || m.dsk === null) return m
    return {
      ...m,
      cpu: clamp(m.cpu + (Math.random() - 0.5) * 7, 4, 97),
      mem: clamp(m.mem + (Math.random() - 0.5) * 2.5, 10, 97),
      dsk: clamp(m.dsk + (Math.random() - 0.48) * 0.4, 5, 97),
    }
  },

  async triggerDeploy() {
    return { outcome: 'queued', message: 'Deployment queued.', deploymentUuid: 'mock-deployment' }
  },
  async cancelDeployment() {
    return { outcome: 'done', message: 'Deployment cancelled.' }
  },
  async setAutoDeploy(_appId: string, enabled: boolean) {
    return { outcome: 'done', message: `Auto-deploy ${enabled ? 'enabled' : 'disabled'}.` }
  },
  async restartApplication() {
    return { outcome: 'queued', message: 'Restart request queued.' }
  },
  async stopApplication() {
    return { outcome: 'done', message: 'Application stopping request queued.' }
  },
  async runScheduledTask() {
    return { outcome: 'queued', message: 'Scheduled task execution queued.' }
  },

  // A plausible report, so the screen can be worked on without an instance:
  // one thing to fix, one thing switched off, one that could not be determined.
  async getSetup() {
    return {
      generatedAt: new Date().toISOString(),
      ok: true,
      coolifyUrl: 'https://coolify.example.com',
      version: 'v4.3.2',
      team: 'Acme',
      checks: [
        { id: 'config', title: 'Configuration', status: 'ok' as const,
          detail: 'COOLIFY_URL is https://coolify.example.com, and a token is set.' },
        { id: 'reachable', title: 'The instance answers', status: 'ok' as const,
          detail: 'Coolify v4.3.2 at https://coolify.example.com.' },
        { id: 'ability-read', title: 'Ability · read', status: 'ok' as const,
          detail: 'Granted — the dashboard can display everything it shows.' },
        { id: 'ability-read-sensitive', title: 'Ability · read:sensitive', status: 'unknown' as const,
          detail: 'No server to ask about, so this could not be determined.' },
        { id: 'ability-deploy', title: 'Ability · deploy', status: 'warn' as const,
          detail: 'Missing required permissions: deploy',
          hint: 'Deploy, cancel, restart and stop will report the missing ability instead of working.',
          link: 'https://coolify.example.com/security/api-tokens' },
        { id: 'password', title: 'Dashboard password', status: 'ok' as const,
          detail: 'Set — the dashboard asks for it and keeps a signed session.' },
        { id: 'webhooks', title: 'Incoming webhooks', status: 'warn' as const,
          detail: 'No WEBHOOK_SECRET, so Coolify cannot push here — updates arrive by polling.' },
      ],
    }
  },

  // No BFF behind the mock, so no door to knock on: the UI goes straight in.
  async getSession() {
    return { required: false, authenticated: true, expiresAt: null }
  },
  async signIn() {
    return { required: false, authenticated: true, expiresAt: null }
  },
  async signOut() {
    return { required: false, authenticated: true, expiresAt: null }
  },
}

export const INITIAL_TRAFFIC = () => 1100 + Math.random() * 300
