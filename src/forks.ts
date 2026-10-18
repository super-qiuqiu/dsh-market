/**
 * Upstream tracking for locally forked plugins ("二开").
 *
 * A fork is still installed from its own source: a `link:` checkout, or a git
 * fork of the market. Its version number follows the upstream release it was
 * forked from, sometimes with a local marker (`0.25.0+qiuqiu.1`,
 * `0.5.4-fork.1`). The market's normal update check deliberately refuses to
 * compare a `link:` checkout online — replacing a development checkout with
 * an npm release is not an update (#497). That is right for "install", and
 * wrong for the question this module answers: "has upstream published a
 * release newer than the base my fork is on?"
 *
 * The answer is read-only and never feeds `updateAvailable`. It is a separate
 * signal so the client can show "二开 · 上游 vX" and the user can merge
 * upstream into their fork themselves. Nothing here installs, removes, or
 * modifies anything.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchNpmLatest } from './updates.ts'
import { readInstalled, readInstalledManifest } from './profile.ts'
import { parseGitHubRemote } from './sources.ts'

/** Explicit mapping for forks the automatic detector cannot name (the market itself, custom forks). */
export interface ForkUpstreamConfig {
  /** npm package whose `latest` is the upstream release. Defaults to the installed package name. */
  readonly npm?: string
  /** `owner/repo`, for display only. */
  readonly repo?: string
}

export interface ForkUpstream {
  /** Version the profile has, including any local marker. */
  readonly installedVersion: string
  /** Upstream version `latest` points at, or null when it could not be read. */
  readonly upstreamVersion: string | null
  /** Upstream is newer than the fork's base version. Never an installable update. */
  readonly updateAvailable: boolean
  /** npm name the comparison used, when it used one. */
  readonly upstreamName: string | null
  /** `owner/repo` of the upstream repository, when known. */
  readonly repo: string | null
}

export interface ForkUpstreamReport {
  readonly checked: number
  readonly forks: Record<string, ForkUpstream>
}

/** Upstream lookups are cached briefly: a page refresh must not re-query npm for every fork. */
const FORK_CACHE_TTL_MS = 5 * 60 * 1000
let forkCache: { key: string; at: number; report: ForkUpstreamReport } | null = null

/** Build metadata and common local fork markers are not part of the upstream version line. */
const LOCAL_FORK_VERSION = /(?:\+[0-9A-Za-z.-]*$)|(?:-[0-9A-Za-z.]*(?:fork|qiuqiu|local)[.-][0-9A-Za-z.-]*)$/i

/**
 * Whether a version string carries a local fork marker.
 *
 * Build metadata (`+qiuqiu.1`) and a local prerelease segment
 * (`-fork.1`, `-qiuqiu.1`, `-local.1`) are the two conventions this machine's
 * forks use. A plain upstream prerelease (`1.66.38-beta.1`) does not match.
 */
export function hasLocalForkMarker(version: string): boolean {
  return LOCAL_FORK_VERSION.test(version)
}

/** The `major.minor.patch` core used for base-version comparison. */
function versionCore(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Whether `candidate` is newer than `base`, comparing the upstream release line only. */
function coreIsNewer(candidate: string, base: string): boolean {
  const a = versionCore(candidate)
  const b = versionCore(base)
  if (a === null || b === null) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!
  }
  return false
}

/** Read `.dsh-market/forks.json`; malformed input is ignored entry by entry. */
export function readForkUpstreamConfig(profileDirectory: string): Record<string, ForkUpstreamConfig> {
  const file = join(profileDirectory, '.dsh-market', 'forks.json')
  if (!existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const config: Record<string, ForkUpstreamConfig> = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (name === '' || typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as { npm?: unknown; repo?: unknown }
    const npm = typeof entry.npm === 'string' && entry.npm.trim() !== '' ? entry.npm.trim() : undefined
    const repo = typeof entry.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo.trim())
      ? entry.repo.trim()
      : undefined
    if (npm !== undefined || repo !== undefined) config[name] = { ...(npm === undefined ? {} : { npm }), ...(repo === undefined ? {} : { repo }) }
  }
  return config
}

/** The installed manifest's version and repository URL, or nulls when unreadable. */
function installedManifestFacts(profile: string, profileDirectory: string, name: string): { version: string | null; repo: string | null } {
  const manifest = readInstalledManifest(profile, name, profileDirectory)
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return { version: null, repo: null }
  const value = manifest as { version?: unknown; repository?: unknown }
  const version = typeof value.version === 'string' && value.version.trim() !== '' ? value.version.trim() : null
  let repositoryUrl: string | null = null
  if (typeof value.repository === 'string') repositoryUrl = value.repository
  else if (typeof value.repository === 'object' && value.repository !== null && !Array.isArray(value.repository)) {
    const url = (value.repository as { url?: unknown }).url
    if (typeof url === 'string') repositoryUrl = url
  }
  const repo = repositoryUrl === null ? null : parseGitHubRemote(repositoryUrl)?.repo ?? null
  return { version, repo }
}

/**
 * Check installed forks against their upstream `latest`.
 *
 * Candidates are explicit entries from `.dsh-market/forks.json` plus local
 * `link:` checkouts whose version carries a fork marker. The market's own
 * git-installed fork is explicit: its version is the upstream version, so
 * nothing in the manifest says "fork".
 *
 * @param profile - Profile name used by the market.
 * @param profileDirectory - Host-authoritative profile directory.
 * @returns Per-fork upstream facts, or an empty report when nothing is tracked.
 */
export async function checkForkUpstreams(profile: string, profileDirectory: string): Promise<ForkUpstreamReport> {
  const installed = readInstalled(profile, profileDirectory)
  const config = readForkUpstreamConfig(profileDirectory)
  const cacheKey = `${profileDirectory}\u0000${Object.entries(installed).map(([name, spec]) => `${name}@${spec}`).sort().join(',')}\u0000${JSON.stringify(config)}`
  if (forkCache !== null && forkCache.key === cacheKey && Date.now() - forkCache.at < FORK_CACHE_TTL_MS) {
    return forkCache.report
  }
  const names = [...new Set([...Object.keys(installed), ...Object.keys(config)])].sort()
  const candidates: { name: string; version: string; repo: string | null; upstreamName: string }[] = []
  for (const name of names) {
    const spec = installed[name]
    if (spec === undefined) continue
    const explicit = config[name]
    const facts = installedManifestFacts(profile, profileDirectory, name)
    const isLink = spec.toLowerCase().startsWith('link:')
    const auto = isLink && facts.version !== null && hasLocalForkMarker(facts.version)
    if (explicit === undefined && !auto) continue
    const version = facts.version
    if (version === null) continue
    const repo = explicit?.repo ?? facts.repo
    candidates.push({ name, version, repo, upstreamName: explicit?.npm ?? name })
  }

  const results = await Promise.all(candidates.map(async (candidate): Promise<[string, ForkUpstream] | null> => {
    const upstreamVersion = await fetchNpmLatest(candidate.upstreamName)
    // An automatically detected checkout with neither a readable upstream
    // version nor a repository has no signal to report; staying out keeps the
    // list from growing a row for every local scratch package.
    if (upstreamVersion === null && candidate.repo === null) return null
    return [candidate.name, {
      installedVersion: candidate.version,
      upstreamVersion,
      updateAvailable: upstreamVersion !== null && coreIsNewer(upstreamVersion, candidate.version),
      upstreamName: upstreamVersion === null ? null : candidate.upstreamName,
      repo: candidate.repo,
    }]
  }))
  const forks: Record<string, ForkUpstream> = {}
  for (const entry of results) if (entry !== null) forks[entry[0]] = entry[1]
  const report: ForkUpstreamReport = { checked: candidates.length, forks }
  forkCache = { key: cacheKey, at: Date.now(), report }
  return report
}
