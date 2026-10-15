/** Compare dotted versions ("0.7.5" vs "0.7.22") numerically per component.
 *  Returns negative, zero or positive the way Array.sort expects. Sould's
 *  versions are plain MAJOR.MINOR.PATCH, so no prerelease handling. */
export declare function compareSemver(a: string, b: string): number;
/** True when a cache entry name is a plain version directory. Anything else
 *  (a marker file, a stray folder) is never a prune candidate. */
export declare function isVersionDirName(name: string): boolean;
export declare function defaultPluginCacheBase(home?: string): string;
export declare function defaultInstalledPluginsFile(home?: string): string;
/** Install paths recorded for sould in Claude Code's installed_plugins.json.
 *  Handles the v2 shape ({ version: 2, plugins: { "sould@<market>": [ { installPath } ] } })
 *  and the older flat shape ({ "sould@<market>": { installPath } }). A missing
 *  or unreadable file yields an empty list. */
export declare function readInstalledSouldPaths(file: string): string[];
/** Default liveness probe. EPERM means the pid exists under another user, which
 *  still counts as alive for a "do not delete under a running process" check. */
export declare function defaultIsPidAlive(pid: number): boolean;
/** Pids with a live process among the marker files in <dir>/.in_use. */
export declare function livePidsInUse(dir: string, isPidAlive: (pid: number) => boolean): number[];
export interface PruneDecision {
    name: string;
    action: "prune" | "keep";
    reason: string;
}
export interface PluginCachePruneOptions {
    /** The directory holding one subdirectory per installed version. */
    cacheBase: string;
    /** The running daemon's version. Nothing at or above it is ever removed. */
    currentVersion: string;
    /** Claude Code's installed_plugins.json; its recorded install path is kept. */
    installedPluginsFile?: string;
    isPidAlive?: (pid: number) => boolean;
    /** Decide and log without deleting. */
    dryRun?: boolean;
    log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
    };
}
export interface PluginCachePruneResult {
    pruned: string[];
    kept: PruneDecision[];
    failed: string[];
}
/** Pure decision pass: one entry per directory under cacheBase. Throws only
 *  when cacheBase itself cannot be read. */
export declare function decidePluginCachePrune(opts: Pick<PluginCachePruneOptions, "cacheBase" | "currentVersion" | "installedPluginsFile" | "isPidAlive">): PruneDecision[];
/** Remove the directories decidePluginCachePrune marks for pruning. Never
 *  throws: a cache that cannot be read is logged and left alone. */
export declare function prunePluginCache(opts: PluginCachePruneOptions): PluginCachePruneResult;
