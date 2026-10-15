/**
 * Plugin cache prune (0.10.7).
 *
 * The daemon removes old copies of itself from Claude Code's plugin cache
 * (~/.claude/plugins/cache/sould-marketplace/sould/<version>) so a host that
 * upgrades for months does not keep roughly 900 MB per version on disk.
 *
 * Until 0.10.6 the prune removed every directory whose name was not the
 * running daemon's own version, newer ones included. Seen live on
 * 2026-10-15: 0.10.5 and 0.10.6 were installed while a 0.10.2 daemon was
 * running. The daemon respawned before Claude Code restarted, deleted both,
 * and the next session started with an install path that did not exist, so
 * the new MCP server never loaded and the old hooks respawned another 0.10.2
 * daemon, which would have deleted the next install as well.
 *
 * A directory is removed only when every check passes:
 *   1. its name is a plain MAJOR.MINOR.PATCH version,
 *   2. that version is strictly lower than the running daemon's,
 *   3. it is not an install path recorded in installed_plugins.json,
 *   4. no live process holds a marker in its .in_use directory (Claude Code
 *      2.1.x writes one <pid> file there per session that loaded the copy).
 *
 * Every removal is logged at warn level so it reaches daemon.log under the
 * default log level; the decisions to keep are logged at info.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Compare dotted versions ("0.7.5" vs "0.7.22") numerically per component.
 *  Returns negative, zero or positive the way Array.sort expects. Sould's
 *  versions are plain MAJOR.MINOR.PATCH, so no prerelease handling. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number(s) || 0);
  const pb = b.split(".").map((s) => Number(s) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

const VERSION_DIR = /^\d+\.\d+\.\d+$/;

/** True when a cache entry name is a plain version directory. Anything else
 *  (a marker file, a stray folder) is never a prune candidate. */
export function isVersionDirName(name: string): boolean {
  return VERSION_DIR.test(name);
}

export function defaultPluginCacheBase(home: string = homedir()): string {
  return join(home, ".claude", "plugins", "cache", "sould-marketplace", "sould");
}

export function defaultInstalledPluginsFile(home: string = homedir()): string {
  return join(home, ".claude", "plugins", "installed_plugins.json");
}

/** Install paths recorded for sould in Claude Code's installed_plugins.json.
 *  Handles the v2 shape ({ version: 2, plugins: { "sould@<market>": [ { installPath } ] } })
 *  and the older flat shape ({ "sould@<market>": { installPath } }). A missing
 *  or unreadable file yields an empty list. */
export function readInstalledSouldPaths(file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: string[] = [];
  const visit = (key: string, value: unknown): void => {
    if (!key.startsWith("sould@")) return;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const p = (item as { installPath?: unknown } | null)?.installPath;
      if (typeof p === "string" && p.length > 0) out.push(p);
    }
  };
  if (parsed && typeof parsed === "object") {
    const root = parsed as Record<string, unknown>;
    const plugins = root.plugins;
    if (plugins && typeof plugins === "object") {
      for (const [k, v] of Object.entries(plugins as Record<string, unknown>)) visit(k, v);
    }
    for (const [k, v] of Object.entries(root)) visit(k, v);
  }
  return out;
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Default liveness probe. EPERM means the pid exists under another user, which
 *  still counts as alive for a "do not delete under a running process" check. */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Pids with a live process among the marker files in <dir>/.in_use. */
export function livePidsInUse(dir: string, isPidAlive: (pid: number) => boolean): number[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, ".in_use"));
  } catch {
    return [];
  }
  const live: number[] = [];
  for (const n of names) {
    const pid = Number(n);
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) live.push(pid);
  }
  return live;
}

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
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface PluginCachePruneResult {
  pruned: string[];
  kept: PruneDecision[];
  failed: string[];
}

/** Pure decision pass: one entry per directory under cacheBase. Throws only
 *  when cacheBase itself cannot be read. */
export function decidePluginCachePrune(
  opts: Pick<PluginCachePruneOptions, "cacheBase" | "currentVersion" | "installedPluginsFile" | "isPidAlive">,
): PruneDecision[] {
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const installed = opts.installedPluginsFile
    ? readInstalledSouldPaths(opts.installedPluginsFile).map(canonicalPath)
    : [];
  const entries = readdirSync(opts.cacheBase, { withFileTypes: true }).filter((e) => e.isDirectory());
  const currentOk = isVersionDirName(opts.currentVersion);
  const decisions: PruneDecision[] = [];
  for (const e of entries) {
    const name = e.name;
    const full = join(opts.cacheBase, name);
    if (!isVersionDirName(name)) {
      decisions.push({ name, action: "keep", reason: "not a version directory" });
      continue;
    }
    if (!currentOk) {
      decisions.push({ name, action: "keep", reason: `running daemon version "${opts.currentVersion}" is not a release version` });
      continue;
    }
    const cmp = compareSemver(name, opts.currentVersion);
    if (cmp === 0) {
      decisions.push({ name, action: "keep", reason: "running daemon" });
      continue;
    }
    if (cmp > 0) {
      decisions.push({ name, action: "keep", reason: "newer than running daemon" });
      continue;
    }
    if (installed.includes(canonicalPath(full))) {
      decisions.push({ name, action: "keep", reason: "recorded install path in installed_plugins.json" });
      continue;
    }
    const live = livePidsInUse(full, isPidAlive);
    if (live.length > 0) {
      decisions.push({ name, action: "keep", reason: `in use by pid ${live.join(", ")}` });
      continue;
    }
    decisions.push({ name, action: "prune", reason: "older than running daemon, not installed, not in use" });
  }
  return decisions;
}

/** Remove the directories decidePluginCachePrune marks for pruning. Never
 *  throws: a cache that cannot be read is logged and left alone. */
export function prunePluginCache(opts: PluginCachePruneOptions): PluginCachePruneResult {
  const result: PluginCachePruneResult = { pruned: [], kept: [], failed: [] };
  if (!existsSync(opts.cacheBase)) return result;
  let decisions: PruneDecision[];
  try {
    decisions = decidePluginCachePrune(opts);
  } catch (e) {
    opts.log.warn(`[daemon] plugin cache prune skipped: ${(e as Error).message}`);
    return result;
  }
  for (const d of decisions) {
    if (d.action === "keep") {
      result.kept.push(d);
      opts.log.info(`[daemon] plugin cache: keeping ${d.name} (${d.reason})`);
      continue;
    }
    if (opts.dryRun) {
      result.pruned.push(d.name);
      continue;
    }
    try {
      rmSync(join(opts.cacheBase, d.name), { recursive: true, force: true });
      result.pruned.push(d.name);
    } catch (e) {
      result.failed.push(d.name);
      opts.log.warn(`[daemon] failed to prune plugin cache ${d.name}: ${(e as Error).message}`);
    }
  }
  if (result.pruned.length > 0) {
    const verb = opts.dryRun ? "would prune" : "pruned";
    opts.log.warn(
      `[daemon] ${verb} ${result.pruned.length} old plugin cache version(s): ${result.pruned.join(", ")} (running ${opts.currentVersion})`,
    );
  }
  return result;
}
