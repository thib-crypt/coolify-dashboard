import { DashboardError, source, type ActionOutcome, type ActionResponse, type PaletteAction } from '../data'
import { useToast } from './useToasts'

/**
 * Every write the dashboard can make, in one place.
 *
 * They all funnel through `run`, so they all behave the same way: one toast
 * carrying Coolify's own wording, one optional refetch, one error path. That
 * matters more here than in most apps because **Coolify answers 200 even when
 * it did nothing** — a deploy skipped because the commit was already queued is
 * a success at the HTTP level and a non-event in reality. `outcome` is what
 * separates them, and it decides the colour of the toast.
 */

export interface Actions {
  deploy(appId: string, name: string): Promise<ActionResponse>
  /** Deploys, then stays pending until the live channel says the build ended. */
  deployAndWatch(appId: string, name: string): Promise<void>
  restart(appId: string, name: string): Promise<ActionResponse>
  stop(appId: string, name: string): Promise<ActionResponse>
  cancel(deploymentId: string, appName: string): Promise<ActionResponse>
  setAutoDeploy(appId: string, name: string, enabled: boolean): Promise<ActionResponse>
  runTask(
    owner: 'application' | 'service',
    ownerId: string,
    taskId: string,
    title: string,
  ): Promise<ActionResponse>
  /** Runs a command palette entry, whatever it turns out to be. */
  runCommand(action: PaletteAction): Promise<unknown>
  /** Toasts something, for the few places that need to say "nothing to do". */
  say(message: string, tone?: 'info' | 'err'): void
}

export interface ActionDeps {
  reload: () => void
  awaitDeployment: (deploymentUuid: string) => Promise<void>
  /** Names an application by id, for the failure messages. */
  nameOf: (id: string) => string
  /** The command palette's one non-upstream entry. */
  onSwitchEnvironment: () => void
}

const COLORS: Record<ActionOutcome, string> = {
  queued: 'var(--accent)',
  done: 'var(--ok)',
  skipped: 'var(--warn)',
}

export function useActions(deps: ActionDeps): Actions {
  const { toast } = useToast()

  /** The BFF already phrased the failure and its remedy; both belong on screen. */
  const report = (cause: unknown, fallback: string) => {
    if (!(cause instanceof DashboardError)) {
      toast(cause instanceof Error ? `${fallback} — ${cause.message}` : fallback, 'var(--err)')
      return
    }
    const retry = cause.retryAfterSeconds ? ` Retry in ${cause.retryAfterSeconds}s.` : ''
    toast(`${cause.message}${retry}${cause.hint ? ` ${cause.hint}` : ''}`, 'var(--err)')
  }

  const run = async (
    failure: string,
    action: () => Promise<ActionResponse>,
    options: { refresh?: boolean } = {},
  ): Promise<ActionResponse> => {
    try {
      const result = await action()
      toast(result.message, COLORS[result.outcome])
      // A push will say so too, but only once Coolify has caught up; refreshing
      // here is what makes the click feel immediate.
      if (options.refresh) deps.reload()
      return result
    } catch (cause) {
      report(cause, failure)
      throw cause
    }
  }

  const actions: Actions = {
    deploy: (appId, name) =>
      run(`Could not deploy ${name}`, () => source.triggerDeploy(appId), { refresh: true }),

    /**
     * The Deploy button's "Deploying" face lasts exactly as long as the promise
     * it was handed. Before the live channel existed that was the length of one
     * HTTP request — a few hundred milliseconds of a build that takes minutes.
     * A skipped deploy has no deployment to wait for, hence the guard.
     */
    async deployAndWatch(appId, name) {
      const result = await actions.deploy(appId, name)
      if (result.deploymentUuid) await deps.awaitDeployment(result.deploymentUuid)
    },

    restart: (appId, name) =>
      run(`Could not restart ${name}`, () => source.restartApplication(appId), { refresh: true }),

    stop: (appId, name) =>
      run(`Could not stop ${name}`, () => source.stopApplication(appId), { refresh: true }),

    cancel: (deploymentId, appName) =>
      run(`Could not cancel ${appName}`, () => source.cancelDeployment(deploymentId), { refresh: true }),

    setAutoDeploy: (appId, name, enabled) =>
      run(`Could not change auto-deploy for ${name}`, () => source.setAutoDeploy(appId, enabled)),

    runTask: (owner, ownerId, taskId, title) =>
      run(`Could not run ${title}`, () => source.runScheduledTask(owner, ownerId, taskId)),

    runCommand(action) {
      const command = action.command
      switch (command.kind) {
        case 'deploy':
          return actions.deploy(command.application, deps.nameOf(command.application))
        case 'restart':
          return actions.restart(command.application, deps.nameOf(command.application))
        case 'stop':
          return actions.stop(command.application, deps.nameOf(command.application))
        case 'run-task':
          return actions.runTask(command.owner, command.ownerId, command.task, action.title)
        case 'ui':
          deps.onSwitchEnvironment()
          return Promise.resolve()
      }
    },

    say: (message, tone = 'info') => toast(message, tone === 'err' ? 'var(--err)' : 'var(--t3)'),
  }

  return actions
}
