/**
 * The daemon must never delete a newer or installed plugin copy (0.10.7).
 *
 * Seen live on 2026-10-15: a 0.10.2 daemon respawned while 0.10.5 and 0.10.6
 * were installed but not yet loaded, and pruned both from Claude Code's plugin
 * cache. The next session started with an install path that did not exist.
 *
 * The directory names below are synthetic (1.x) so the release script's sweep
 * for the outgoing release number never trips on this file.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareSemver,
  isVersionDirName,
  readInstalledSouldPaths,
  livePidsInUse,
  decidePluginCachePrune,
  prunePluginCache,
} from "../src/daemon/plugin-cache-prune.js";

const temps: string[] = [];
function makeTemp(): string {
  const d = mkdtempSync(join(tmpdir(), "sould-prune-"));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeLog() {
  const info: string[] = [];
  const warn: string[] = [];
  return { info: (m: string) => { info.push(m); }, warn: (m: string) => { warn.push(m); }, lines: { info, warn } };
}

function cacheCopy(base: string, name: string, inUsePids: number[] = []): string {
  const d = join(base, name);
  mkdirSync(join(d, "dist"), { recursive: true });
  writeFileSync(join(d, "dist", "marker.txt"), name);
  if (inUsePids.length) {
    mkdirSync(join(d, ".in_use"));
    for (const pid of inUsePids) writeFileSync(join(d, ".in_use", String(pid)), JSON.stringify({ pid }));
  }
  return d;
}

describe("compareSemver and cache directory names", () => {
  it("orders numerically per component", () => {
    expect(compareSemver("1.2.3", "1.2.9")).toBeLessThan(0);
    expect(compareSemver("1.2.9", "1.2.3")).toBeGreaterThan(0);
    expect(compareSemver("1.9.99", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "2.0.0")).toBe(0);
  });
  it("accepts only plain MAJOR.MINOR.PATCH names", () => {
    expect(isVersionDirName("1.2.3")).toBe(true);
    expect(isVersionDirName("node_modules")).toBe(false);
    expect(isVersionDirName("1.2.3-rc1")).toBe(false);
    expect(isVersionDirName(".in_use")).toBe(false);
  });
});

describe("readInstalledSouldPaths", () => {
  it("reads the v2 shape with an array per plugin", () => {
    const d = makeTemp();
    const f = join(d, "installed_plugins.json");
    writeFileSync(f, JSON.stringify({
      version: 2,
      plugins: {
        "sould@sould-marketplace": [{ scope: "user", installPath: "/x/cache/sould-marketplace/sould/1.2.5", version: "1.2.5" }],
        "codex@openai-codex": [{ installPath: "/x/cache/openai-codex/codex/1.0.4" }],
      },
    }));
    expect(readInstalledSouldPaths(f)).toEqual(["/x/cache/sould-marketplace/sould/1.2.5"]);
  });
  it("reads the older flat shape", () => {
    const d = makeTemp();
    const f = join(d, "installed_plugins.json");
    writeFileSync(f, JSON.stringify({ "sould@sould-marketplace": { installPath: "/y/1.1.0" } }));
    expect(readInstalledSouldPaths(f)).toEqual(["/y/1.1.0"]);
  });
  it("returns nothing for a missing or malformed file", () => {
    const d = makeTemp();
    expect(readInstalledSouldPaths(join(d, "nope.json"))).toEqual([]);
    const f = join(d, "bad.json");
    writeFileSync(f, "{not json");
    expect(readInstalledSouldPaths(f)).toEqual([]);
  });
});

describe("livePidsInUse", () => {
  it("reports only markers whose pid is alive", () => {
    const base = makeTemp();
    const d = cacheCopy(base, "1.2.5", [111, 222, 333]);
    const alive = (pid: number) => pid === 222;
    expect(livePidsInUse(d, alive)).toEqual([222]);
    expect(livePidsInUse(cacheCopy(base, "1.2.4"), alive)).toEqual([]);
  });
});

describe("prunePluginCache", () => {
  it("regression (the 2026-10-15 shape): an old daemon leaves two newer installed copies alone", () => {
    const base = makeTemp();
    cacheCopy(base, "1.2.3");
    cacheCopy(base, "1.2.5");
    cacheCopy(base, "1.2.6");
    const log = makeLog();
    const r = prunePluginCache({ cacheBase: base, currentVersion: "1.2.3", isPidAlive: () => false, log });
    expect(r.pruned).toEqual([]);
    expect(existsSync(join(base, "1.2.5"))).toBe(true);
    expect(existsSync(join(base, "1.2.6"))).toBe(true);
    expect(r.kept.map((k) => [k.name, k.reason])).toEqual([
      ["1.2.3", "running daemon"],
      ["1.2.5", "newer than running daemon"],
      ["1.2.6", "newer than running daemon"],
    ]);
    expect(log.lines.warn).toEqual([]);
  });

  it("removes only older copies that are neither installed nor in use, and says so at warn level", () => {
    const base = makeTemp();
    const home = makeTemp();
    cacheCopy(base, "1.2.3");
    cacheCopy(base, "1.2.5");
    cacheCopy(base, "1.2.9");
    const recorded = cacheCopy(base, "1.1.9");
    cacheCopy(base, "1.1.8", [4242]);
    cacheCopy(base, "1.1.7", [9999]);
    mkdirSync(join(base, "node_modules"));
    const installed = join(home, "installed_plugins.json");
    writeFileSync(installed, JSON.stringify({ version: 2, plugins: { "sould@sould-marketplace": [{ installPath: recorded }] } }));
    const log = makeLog();
    const r = prunePluginCache({
      cacheBase: base,
      currentVersion: "1.2.5",
      installedPluginsFile: installed,
      isPidAlive: (pid) => pid === 4242,
      log,
    });
    expect(r.pruned.sort()).toEqual(["1.1.7", "1.2.3"]);
    expect(r.failed).toEqual([]);
    expect(existsSync(join(base, "1.2.3"))).toBe(false);
    expect(existsSync(join(base, "1.1.7"))).toBe(false);
    for (const kept of ["1.2.5", "1.2.9", "1.1.9", "1.1.8", "node_modules"]) {
      expect(existsSync(join(base, kept)), kept).toBe(true);
    }
    const reasons = Object.fromEntries(r.kept.map((k) => [k.name, k.reason]));
    expect(reasons["1.2.5"]).toBe("running daemon");
    expect(reasons["1.2.9"]).toBe("newer than running daemon");
    expect(reasons["1.1.9"]).toBe("recorded install path in installed_plugins.json");
    expect(reasons["1.1.8"]).toBe("in use by pid 4242");
    expect(reasons["node_modules"]).toBe("not a version directory");
    expect(log.lines.warn).toHaveLength(1);
    expect(log.lines.warn[0]).toContain("pruned 2 old plugin cache version(s)");
    expect(log.lines.warn[0]).toContain("1.2.3");
    expect(log.lines.warn[0]).toContain("1.1.7");
    expect(log.lines.warn[0]).toContain("running 1.2.5");
  });

  it("prunes nothing when the running daemon is not on a release number", () => {
    const base = makeTemp();
    cacheCopy(base, "1.2.3");
    cacheCopy(base, "1.2.5");
    const log = makeLog();
    const r = prunePluginCache({ cacheBase: base, currentVersion: "0.0.0-dev", isPidAlive: () => false, log });
    expect(r.pruned).toEqual([]);
    expect(existsSync(join(base, "1.2.3"))).toBe(true);
    expect(r.kept.every((k) => k.reason.includes("not a release version"))).toBe(true);
  });

  it("dry run decides and reports without deleting", () => {
    const base = makeTemp();
    cacheCopy(base, "1.2.3");
    cacheCopy(base, "1.2.5");
    const log = makeLog();
    const r = prunePluginCache({ cacheBase: base, currentVersion: "1.2.5", isPidAlive: () => false, dryRun: true, log });
    expect(r.pruned).toEqual(["1.2.3"]);
    expect(existsSync(join(base, "1.2.3"))).toBe(true);
    expect(log.lines.warn[0]).toContain("would prune 1 old plugin cache version(s): 1.2.3");
  });

  it("is a no-op on a missing cache directory and never throws", () => {
    const log = makeLog();
    const r = prunePluginCache({ cacheBase: join(makeTemp(), "absent"), currentVersion: "1.2.5", log });
    expect(r).toEqual({ pruned: [], kept: [], failed: [] });
    expect(log.lines.warn).toEqual([]);
  });

  it("decision pass alone does not touch the disk", () => {
    const base = makeTemp();
    cacheCopy(base, "1.2.3");
    const d = decidePluginCachePrune({ cacheBase: base, currentVersion: "1.2.5", isPidAlive: () => false });
    expect(d).toEqual([{ name: "1.2.3", action: "prune", reason: "older than running daemon, not installed, not in use" }]);
    expect(existsSync(join(base, "1.2.3"))).toBe(true);
  });
});
