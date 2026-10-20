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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { INSTALL_TIMEOUT_MS, killTree, progress, } from './dsh-cli.js';
import { readManifestDeps } from './profile.js';
import { repoOfTarget } from './sources.js';
import { activeRegion, DEFAULT_NPM_REGISTRY, routesFor } from './regions.js';
/** The market's own package names. Mirrors `SELF_NAMES` in official-desktop.ts. */
const SELF_NAMES = new Set(['dshmarket', 'dsh-market']);
/** A package spec's registry name, or undefined when it is not a registry spec. */
function registryNameOf(spec) {
    // Start at 1 so a scoped name's leading `@` is not mistaken for a version.
    const at = spec.indexOf('@', 1);
    const name = at === -1 ? spec : spec.slice(0, at);
    return /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(name) ? name : undefined;
}
/** The part of a target that identifies its repository, without selectors. */
function repositoryKeyOf(spec) {
    const repo = repoOfTarget(spec);
    return repo === null ? null : repo.split('#')[0] ?? repo;
}
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
export function isSelfUpdateTarget(profileName, profileDirectory, spec) {
    const name = registryNameOf(spec);
    if (name !== undefined)
        return SELF_NAMES.has(name);
    if (profileDirectory === undefined)
        return false;
    const dependencies = readManifestDeps(profileName, profileDirectory);
    const installed = dependencies.dshmarket ?? dependencies['dsh-market'];
    if (installed === undefined)
        return false;
    const targetRepo = repositoryKeyOf(spec);
    const installedRepo = repositoryKeyOf(installed);
    return targetRepo !== null && installedRepo !== null && targetRepo === installedRepo;
}
/** The pnpm run currently owned by the self-update runner, if any. */
let activeSelfUpdate = null;
/** Cancel the market's own update and kill its pnpm process group. */
export function cancelSelfUpdate() {
    const active = activeSelfUpdate;
    if (active === null)
        return false;
    activeSelfUpdate = null;
    active.cancel();
    return true;
}
/** Whether a self-update run currently owns a pnpm child. */
export function selfUpdateRunning() {
    return activeSelfUpdate !== null;
}
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
export function runSelfUpdate(profileDirectory, spec, packageManager, spawnImpl = spawn) {
    const args = ['add'];
    if (existsSync(join(profileDirectory, 'pnpm-workspace.yaml')))
        args.push('-w');
    args.push(spec);
    // Match the host's own registry selection without overriding a registry the
    // host already put in the environment: a GUI-launched Desktop ships no shell
    // env, and the market's region setting is the one the user chose (#862).
    const env = { ...process.env, ...packageManager.env };
    const mirror = routesFor(activeRegion()).npmRegistry;
    if (mirror !== DEFAULT_NPM_REGISTRY
        && env.npm_config_registry === undefined
        && env.PNPM_CONFIG_REGISTRY === undefined) {
        env.npm_config_registry = `${mirror}/`;
    }
    // pnpm v10+ blocks forever on an interactive prompt without a TTY. Every
    // other market install forces CI mode; this one has to as well.
    env.CI = '1';
    progress.active = true;
    progress.target = spec;
    progress.startedAt = Date.now();
    progress.lastLine = '';
    progress.phase = null;
    progress.done = 0;
    progress.total = null;
    progress.currentPackage = null;
    progress.downloaded = null;
    progress.size = null;
    progress.ndjson = false;
    progress.error = null;
    progress.cancelling = false;
    return new Promise((resolvePromise) => {
        let child;
        try {
            child = spawnImpl(packageManager.command, [...packageManager.args, ...args], {
                cwd: profileDirectory,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                // Own process group on POSIX so a timeout/cancel stops pnpm's children too.
                detached: process.platform !== 'win32',
            });
        }
        catch (error) {
            progress.active = false;
            const message = error instanceof Error ? error.message : String(error);
            progress.error = message;
            resolvePromise({ exitCode: 127, timedOut: false, stdout: '', stderr: message, cancelled: false, wroteNothing: true });
            return;
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let cancelled = false;
        const timer = setTimeout(() => {
            timedOut = true;
            progress.cancelling = true;
            killTree(child);
        }, INSTALL_TIMEOUT_MS);
        const record = {
            child,
            cancel: () => {
                cancelled = true;
                progress.cancelling = true;
                killTree(child);
            },
        };
        activeSelfUpdate = record;
        const note = (text) => {
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (trimmed !== '' && !trimmed.startsWith('{'))
                    progress.lastLine = trimmed.slice(0, 200);
            }
        };
        child.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            stdout = (stdout + text).slice(-256 * 1024);
            note(text);
        });
        child.stderr?.on('data', (chunk) => {
            const text = chunk.toString();
            stderr = (stderr + text).slice(-64 * 1024);
            note(text);
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            if (activeSelfUpdate === record)
                activeSelfUpdate = null;
            progress.active = false;
            progress.cancelling = false;
            const message = error.message;
            progress.error = message;
            // Nothing started: no manifest or lockfile was written.
            resolvePromise({
                exitCode: 127,
                timedOut: false,
                stdout,
                stderr: `${stderr}\n${message}`.trim(),
                cancelled: false,
                wroteNothing: true,
            });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (activeSelfUpdate === record)
                activeSelfUpdate = null;
            progress.active = false;
            progress.cancelling = false;
            const exitCode = code ?? 1;
            if (exitCode !== 0 || timedOut)
                progress.error = stderr.trim().slice(-1000) || `pnpm exited with ${String(exitCode)}`;
            resolvePromise({
                exitCode,
                timedOut,
                stdout,
                stderr,
                cancelled,
                wroteNothing: false,
            });
        });
    });
}
