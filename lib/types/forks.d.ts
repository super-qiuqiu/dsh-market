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
/** Explicit mapping for forks the automatic detector cannot name (the market itself, custom forks). */
export interface ForkUpstreamConfig {
    /** npm package whose `latest` is the upstream release. Defaults to the installed package name. */
    readonly npm?: string;
    /** `owner/repo`, for display only. */
    readonly repo?: string;
}
export interface ForkUpstream {
    /** Version the profile has, including any local marker. */
    readonly installedVersion: string;
    /** Upstream version `latest` points at, or null when it could not be read. */
    readonly upstreamVersion: string | null;
    /** Upstream is newer than the fork's base version. Never an installable update. */
    readonly updateAvailable: boolean;
    /** npm name the comparison used, when it used one. */
    readonly upstreamName: string | null;
    /** `owner/repo` of the upstream repository, when known. */
    readonly repo: string | null;
}
export interface ForkUpstreamReport {
    readonly checked: number;
    readonly forks: Record<string, ForkUpstream>;
}
/**
 * Whether a version string carries a local fork marker.
 *
 * Build metadata (`+qiuqiu.1`) and a local prerelease segment
 * (`-fork.1`, `-qiuqiu.1`, `-local.1`) are the two conventions this machine's
 * forks use. A plain upstream prerelease (`1.66.38-beta.1`) does not match.
 */
export declare function hasLocalForkMarker(version: string): boolean;
/** Read `.dsh-market/forks.json`; malformed input is ignored entry by entry. */
export declare function readForkUpstreamConfig(profileDirectory: string): Record<string, ForkUpstreamConfig>;
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
export declare function checkForkUpstreams(profile: string, profileDirectory: string): Promise<ForkUpstreamReport>;
