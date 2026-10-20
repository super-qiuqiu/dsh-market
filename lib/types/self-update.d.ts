/**
 * Self-update for the market on the official Desktop host.
 *
 * The Desktop host owns the profile and publishes its bundled package manager
 * through `profileContext.packageManager` (#653). The host's plugin manager
 * cannot express "update an installed package in place": on DSH 0.2.1 it
 * answers `already-installed`, and its only update shape is remove-then-install
 * (#896) — which for the market itself unloads the code that was going to
 * perform the reinstall (#900). The market therefore cannot update itself by
 * asking the manager.
 *
 * What it can do is run the host's own pnpm against the profile the way the
 * host itself would: same executable, same environment, same working
 * directory. That replaces the package files in place, without touching
 * `dsh.profile.bundles` and without ever removing the running bundle. The
 * running process keeps serving the modules it already imported; the next
 * start loads the new build, exactly like every other update that replaces a
 * live host half. `activationAfterReplace` already reports that as "restart".
 *
 * This module is deliberately narrow: it only ever runs `add` (never `remove`,
 * `update` or `install`), only for a spec that names the market itself, and
 * only when the host published a package manager. Every other package still
 * goes through the host's managed pipeline.
 */
import { type ChildProcess } from 'node:child_process';
import { type HostPackageManager, type InstallResult } from './dsh-cli.ts';
/**
 * Whether an `add` target names the market itself.
 *
 * The ordinary install is a registry spec (`dshmarket@1.66.38`), which the
 * name alone answers. A fork installed from git keeps the same package name
 * in its manifest but is updated through its repository URL, so the target
 * and the profile's own declaration are compared by repository instead.
 * Without that comparison a git-hosted market would silently fall back to the
 * host manager and hit the `already-installed` refusal again.
 *
 * @param profileName - Profile whose manifest is read for the git comparison.
 * @param profileDirectory - Host-authoritative profile directory, when known.
 * @param spec - The `add` target the update route built.
 * @returns whether this target is the running market.
 */
export declare function isSelfUpdateTarget(profileName: string, profileDirectory: string | undefined, spec: string): boolean;
/** A spawn implementation, injectable so the behavior is testable without pnpm. */
export type SpawnSelfUpdate = (command: string, args: string[], options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'pipe'];
    detached: boolean;
}) => ChildProcess;
/** Cancel the market's own update and kill its pnpm process group. */
export declare function cancelSelfUpdate(): boolean;
/** Whether a self-update run currently owns a pnpm child. */
export declare function selfUpdateRunning(): boolean;
/**
 * Run the host's package manager for the market's own `add`.
 *
 * Mirrors what the host's plugin manager does for every other package: the
 * host's executable and environment, the profile as the working directory,
 * `-w` only inside a pnpm workspace, and the market's selected registry
 * mirror. It never removes anything, so the running market stays loaded.
 *
 * @param profileDirectory - Profile directory owned by the host.
 * @param spec - Exact `add` target, already validated by the caller.
 * @param packageManager - `profileContext.packageManager` from the host.
 * @param spawnImpl - Spawn implementation; production uses `node:child_process`.
 * @returns The same shape every plugin command returns, including `wroteNothing`
 *   when the process never started, so the update route skips its rollback.
 */
export declare function runSelfUpdate(profileDirectory: string, spec: string, packageManager: HostPackageManager, spawnImpl?: SpawnSelfUpdate): Promise<InstallResult>;
