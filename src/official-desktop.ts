/** The official Electron profile is owned by DSH's in-process plugin manager. */

import { randomUUID } from 'node:crypto'
import { progress, TARGET_RE, type DesktopPluginRuntime, type HostPackageManager, type InstallResult } from './dsh-cli.ts'
import { activeRegion, DEFAULT_NPM_REGISTRY, routesFor } from './regions.ts'
import { cancelSelfUpdate, isSelfUpdateTarget, runSelfUpdate, selfUpdateRunning } from './self-update.ts'

interface ManagedResult {
  application: string
  error?: unknown
  packageResult?: { exitCode: number | null; output?: string }
}

export interface OfficialPluginManagerLike {
  installBundle(spec: string, options?: { requestId?: string; registry?: string }): Promise<ManagedResult>
  removeBundle(name: string): Promise<ManagedResult>
  cancelInstall(requestId: string): Promise<unknown>
}

/**
 * What a user can actually do when the market cannot perform an operation on
 * the official Desktop profile: the app's own Plugins page runs the same
 * managed pipeline. Bilingual, because it is read in the operations panel.
 */
export const OFFICIAL_PAGE_HINT = '官方桌面客户端的这个插件操作需要在「设置 → 插件」里完成；市场无法通过命令行修改桌面端的 profile。 / On the official desktop app, do this from Settings → Plugins; the market cannot change the desktop profile through the command line.'

function failure(message: string, exitCode = 1): InstallResult {
  return { exitCode, timedOut: false, stdout: '', stderr: message, cancelled: false }
}

function detail(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error === undefined) return 'plugin manager did not explain the failure'
  const code = managementCode(error)
  const copy = code === undefined ? undefined : REFUSAL_COPY[code]
  // The code stays on the line: it is what the log and the issue report carry.
  if (copy !== undefined) return `${copy.zh} / ${copy.en} (${code})`
  const message = (error as { message?: unknown }).message
  if (typeof message === 'string' && message !== '') return message
  return JSON.stringify(error)
}

/**
 * What the manager's refusal means, in the user's terms.
 *
 * These codes are the manager's localization keys, not sentences; they used to
 * reach the page as `{"code":"already-installed"}` and, on the update route,
 * wrapped in "restoration of the previous build could not be verified" — alarm
 * about a profile that was never touched (#897). The bilingual half is picked
 * by the same `localizeBilingual` every other server message goes through.
 */
const REFUSAL_COPY: Record<string, { zh: string; en: string }> = {
  'already-installed': {
    zh: '桌面端认为这个包已经装在 profile 里，因此在运行 pnpm 之前就拒绝了这次安装，profile 没有任何改动',
    en: 'the desktop app treats this package as already installed and refused the install before pnpm ran, so the profile is unchanged',
  },
  'not-removable': {
    zh: '这个插件由桌面端自己管理，市场不能移除它',
    en: 'the desktop app manages this plugin itself, so the market cannot remove it',
  },
  'bundle-in-use': {
    zh: '这个插件正在使用中，桌面端不允许现在移除',
    en: 'the plugin is in use, and the desktop app will not remove it right now',
  },
  'stop-profile': {
    zh: '要移除它得先停止这个 profile',
    en: 'removing it requires stopping this profile first',
  },
  'management-required': {
    zh: '这个 profile 由桌面端自己管理，市场不能直接改动',
    en: 'this profile is managed by the desktop app itself, so the market cannot change it',
  },
  'incompatible-version': {
    zh: '这个版本与当前 DSH 不兼容，宿主拒绝安装',
    en: 'this version is not compatible with the running DSH, so the host refused it',
  },
}

/**
 * The market's own package names. A desktop profile installs it from npm as
 * `dshmarket`; a fork or a local checkout can declare the repository's name.
 */
const SELF_NAMES = new Set(['dshmarket', 'dsh-market'])

/**
 * Why the market will not remove itself to update, and what to do instead.
 *
 * The manager's `removeBundle` drops the bundle from the running composition
 * before pnpm runs. For every other package that is a normal unload; for the
 * market it unloads the very code that was going to install the new version,
 * so the reinstall never happens and the profile is left with the bundle row
 * gone and the dependency still declared (#900). The app's own Plugins page
 * performs the same two steps from outside the market and survives.
 */
function selfUpdateMessage(spec: string): string {
  const at = spec.indexOf('@', 1)
  const version = at === -1 ? '' : spec.slice(at + 1)
  const target = version === '' ? spec : `${registryNameOf(spec) ?? spec}@${version}`
  return `市场不能在自己的请求里先卸载自己：桌面端的移除会先把市场从正在运行的组合里摘掉，补装那一步就再也执行不到了（#900）。请在桌面端的「设置 → 插件」里更新市场${version === '' ? '' : ` 到 ${version}`}，或完全退出 DSH 后在终端执行 \`dsh plugin --profile desktop add ${target}\`。 / The market cannot remove itself to update: the desktop app unloads it from the running composition first, so the reinstall never runs (#900). Update it from the desktop app's Settings → Plugins${version === '' ? '' : ` (to ${version})`}, or quit DSH completely and run \`dsh plugin --profile desktop add ${target}\` in a terminal.`
}

/** The manager's own refusal code, whether it was returned or thrown. */
function managementCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** `dshmarket@1.66.32` → `dshmarket`; anything that is not a registry name stays unparsed. */
export function registryNameOf(spec: string): string | undefined {
  // Start at 1 so a scoped name's leading `@` is not mistaken for a version.
  const at = spec.indexOf('@', 1)
  const name = at === -1 ? spec : spec.slice(0, at)
  return /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(name) ? name : undefined
}

/**
 * Install a spec, and when the manager refuses it because that package is
 * already in the profile, remove the installed copy first and install again.
 *
 * dsh 0.2.1's plugin manager treats `add` on an existing dependency as
 * `already-installed` outright (#896). An update is exactly that shape, and
 * the app's own Plugins page updates a bundle the same two-step way —
 * `removeBundle` then install — because its manager has no in-place update.
 * Without this the market could not update ANY installed plugin on that host,
 * itself included: users stuck on a broken build could not fetch the fix.
 */
async function installOrReinstall(
  manager: OfficialPluginManagerLike,
  spec: string,
  options: { requestId?: string; registry?: string },
): Promise<ManagedResult> {
  const install = (): Promise<ManagedResult> => manager.installBundle(spec, options)
  let first: ManagedResult
  try {
    first = await install()
  } catch (error) {
    if (managementCode(error) !== 'already-installed') throw error
    first = { application: 'failed', error }
  }
  if (first.application !== 'failed' || managementCode(first.error) !== 'already-installed') return first
  const name = registryNameOf(spec)
  // A refusal we cannot turn into a name is the manager's answer to give.
  if (name === undefined) return first
  // Removing the market would unload this very code before the reinstall runs
  // (#900). Say how to update it instead.
  if (SELF_NAMES.has(name)) {
    return { application: 'failed', error: { code: 'market-self-update', message: selfUpdateMessage(spec) } }
  }
  progress.lastLine = 'Removing the installed copy so the desktop app can install the new version'
  const removed = await manager.removeBundle(name)
  if (removed.application === 'failed' || removed.application === 'cancelled') return removed
  progress.lastLine = 'Installing the new version'
  return install()
}

/**
 * Never fall back to `dsh plugin --profile desktop`.
 *
 * Up to dsh 0.2.0-rc.1 the CLI refused that profile outright. From rc.2 it
 * accepts it only when Desktop's own carrier invokes it, with Desktop fully
 * quit — it takes a 120 s lock on the profile's package.json and says "fully
 * quit it before running". The market only ever runs inside a live Desktop, so
 * for the market the answer is the same on every version: the app's own
 * plugin manager is the only door.
 */
export type SelfUpdateRunner = (
  profileDirectory: string,
  spec: string,
  packageManager: HostPackageManager,
) => Promise<InstallResult>

export function createOfficialDesktopRuntime(
  managerLookup: () => OfficialPluginManagerLike | undefined,
  profileName: string,
  // The launcher's authoritative profile directory. Required for the market's
  // own update: the host manager cannot update it, so that one operation runs
  // the host's pnpm directly against this directory.
  profileDirectory?: string,
  // `profileContext.packageManager`: the host's bundled node + pnpm. Absent on
  // hosts that only expose the manager (and on an explicitly configured
  // `profile: desktop` with no launcher, #744), where self-update keeps the
  // existing refusal instead of inventing a path.
  packageManager?: HostPackageManager | null,
  runSelfUpdateImpl: SelfUpdateRunner = runSelfUpdate,
): DesktopPluginRuntime {
  let disposed = false
  let active: { requestId?: string; cancelled: boolean; done: Promise<InstallResult> } | undefined

  const runPlugin: DesktopPluginRuntime['runPlugin'] = (profile, argv) => {
    if (disposed) return Promise.resolve(failure('official desktop plugin runtime is disposed', 127))
    if (profile !== profileName) return Promise.resolve(failure('refusing to change a different profile', 127))
    if (active !== undefined) return Promise.resolve({ ...failure('another plugin operation is running', 127), busy: true })

    // Market sends pnpm argv. Only operations representable by the official
    // manager are accepted; silently dropping pnpm flags would change intent.
    const [command, target, ...extra] = argv
    if (extra.length !== 0 || typeof target !== 'string' || !TARGET_RE.test(target)) {
      // The market's own options are what usually lands here, and they are
      // spelled with a leading `-` — and they sit in the TARGET slot, because
      // the market writes `add <option> <target>`. The OPERATION is supported
      // here; only the option is not, and reporting that as "this desktop
      // operation is not supported" is what made #732 read as a broken
      // profile. Name the option and the way out instead.
      const options = argv.slice(1).filter(argument => argument.startsWith('-')).join(' ')
      return Promise.resolve(failure(options === ''
        ? 'this desktop operation is not supported by the official plugin manager'
        : `官方桌面客户端自己执行这次安装，不接受市场附加的参数（${options}），这个选项在它这里用不了。可以改用普通 dsh web 安装，或等这个版本过了新版本等待期再试。 / The official desktop app runs this install itself and takes no options from the market (${options}); that option cannot be used here. Install from plain dsh web, or try again once the release is past the fresh-release wait.`, 127))
    }
    const spec = target
    // Only `add` and `remove` map onto the manager. `update` reached here only
    // for the #564 in-place re-resolve of a floating git spec, and no route
    // builds it any more: on a host with this contract the routes express that
    // re-resolve as `add <spec>` (#786), which pnpm does re-resolve — it is
    // `install` that skips a resolution. Turning `update` into `name@latest`
    // (as a first draft did) would cross the installed range and ignore the
    // release channel, which is a different operation, so the refusal stays
    // for any caller that asks for something the manager cannot express.
    if (command !== 'add' && command !== 'remove') {
      return Promise.resolve(failure(OFFICIAL_PAGE_HINT, 127))
    }

    // The market itself is the one package the host's manager cannot update:
    // it answers `already-installed` and its only fallback removes the running
    // bundle before the reinstall can happen (#896, #900). Run the host's own
    // pnpm instead, which updates in place and never touches the bundle row.
    // The spec is interpreted only after TARGET_RE above, and only when the
    // host actually published the package manager it runs pnpm with (#653).
    if (command === 'add'
      && packageManager != null
      && profileDirectory !== undefined
      && isSelfUpdateTarget(profileName, profileDirectory, spec)) {
      const current: { requestId?: string; cancelled: boolean; done: Promise<InstallResult> } = {
        cancelled: false,
        done: Promise.resolve(failure('not started')),
      }
      active = current
      progress.active = true
      progress.target = target
      progress.startedAt = Date.now()
      progress.lastLine = 'Updating the plugin market with the host package manager'
      progress.error = null
      progress.cancelling = false
      current.done = Promise.resolve()
        .then(() => runSelfUpdateImpl(profileDirectory, spec, packageManager))
        .finally(() => {
          progress.active = false
          progress.cancelling = false
          if (active === current) active = undefined
        })
      return current.done
    }

    const manager = managerLookup()
    if (manager === undefined
      || typeof manager.installBundle !== 'function'
      || typeof manager.removeBundle !== 'function'
      || typeof manager.cancelInstall !== 'function') {
      return Promise.resolve(failure(OFFICIAL_PAGE_HINT, 127))
    }

    const requestId = command === 'remove' ? undefined : randomUUID()
    progress.active = true
    progress.target = target
    progress.startedAt = Date.now()
    progress.lastLine = 'Using the official desktop plugin manager'
    progress.error = null
    progress.cancelling = false
    let operation: Promise<ManagedResult>
    try {
      // Read at each operation so region switches apply without a restart.
      // The default route leaves the host's own npm configuration in charge.
      const registry = routesFor(activeRegion()).npmRegistry
      const options = { requestId, ...(registry === DEFAULT_NPM_REGISTRY ? {} : { registry }) }
      operation = command === 'remove'
        ? manager.removeBundle(target)
        : installOrReinstall(manager, spec, options)
    } catch (error) {
      progress.active = false
      return Promise.resolve(failure(detail(error), 127))
    }
    const current = { requestId, cancelled: false, done: Promise.resolve(failure('not started')) }
    active = current
    current.done = operation.then((result): InstallResult => {
      // `overridden` is a change the manager KEPT (`changed: true`) whose live
      // state differs because another layer — a user patch — overrides it.
      // It is not a failed install: reporting it as one sent the update route
      // into a rollback of a change the manager had already kept.
      const ok = result.application === 'applied'
        || result.application === 'restart-required'
        || result.application === 'overridden'
      const output = [
        result.packageResult?.output ?? '',
        result.application === 'overridden' ? 'the plugin manager kept this change, but another layer overrides whether it is enabled' : '',
      ].filter(Boolean).join('\n')
      const message = ok ? '' : detail(result.error)
      if (!ok) progress.error = message
      return {
        // `||`, not `??`: a failure at stage `enable` follows a SUCCESSFUL
        // pnpm step, so packageResult.exitCode is 0 there — and every route
        // reads exit 0 as success. A failed application must never be 0.
        exitCode: ok ? 0 : (result.packageResult?.exitCode || 1),
        timedOut: false,
        stdout: output,
        stderr: message,
        cancelled: current.cancelled || result.application === 'cancelled',
        // No package result means the manager stopped before it ran pnpm: the
        // profile is untouched, and the route must not try to "restore" it.
        wroteNothing: !ok && result.packageResult === undefined,
      }
    }, (error): InstallResult => {
      const message = detail(error)
      progress.error = message
      return { ...failure(message, 127), wroteNothing: managementCode(error) !== undefined }
    }).finally(() => {
      progress.active = false
      progress.cancelling = false
      if (active === current) active = undefined
    })
    return current.done
  }

  return {
    runPlugin,
    probePnpm: async () => managerLookup() !== undefined,
    provisionPnpm: async () => ({ ok: managerLookup() !== undefined, hint: 'Use the official desktop plugin manager' }),
    cancelActive: () => {
      if (selfUpdateRunning()) {
        cancelSelfUpdate()
        return true
      }
      if (active?.requestId === undefined) return false
      active.cancelled = true
      progress.cancelling = true
      const manager = managerLookup()
      if (manager !== undefined) void manager.cancelInstall(active.requestId).catch(() => {})
      return true
    },
    supportsExactRollbackTarget: target => TARGET_RE.test(target),
    // The reason the flag exists (#732): this manager takes exactly
    // `add <target>` or `remove <target>`, so every recovery step that needs
    // an option has to be left out here rather than sent and refused.
    acceptsMarketPnpmFlags: false,
    dispose: async () => {
      disposed = true
      if (selfUpdateRunning()) cancelSelfUpdate()
      if (active?.requestId !== undefined) {
        const manager = managerLookup()
        if (manager !== undefined) void manager.cancelInstall(active.requestId).catch(() => {})
      }
      await active?.done
    },
  }
}
