/**
 * 0.10.8: the hook proxy's SessionStart waits for a daemon it just spawned.
 *
 * The idle reaper exits the daemon 60 s after the last session closes, so the
 * next session's SessionStart found no socket, printed the daemon-down notice
 * and failed open. The session then ran without its wakeup, routines and
 * (until UserPromptSubmit) its task/project pillars. Boot to socket-ready is
 * about 3.5 s; the hook has a 30 s budget. These tests drive run() against a
 * fake daemon on a Unix socket in a temp HOME. POSIX only (Unix sockets).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const require = createRequire(import.meta.url);
const PROXY = join(__dirname, "..", "hooks", "scripts", "hook-proxy.cjs");
const REPLY = JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hello from the daemon" },
});

type Proxy = {
  run: (o: { event: string; body: string; spawnDaemon?: () => void; waitMs?: number }) => Promise<string>;
  waitForDaemon: (deadlineAt: number, pollMs?: number) => Promise<unknown>;
  SESSION_START_WAIT_MS: number;
};

function loadProxy(home: string): Proxy {
  process.env.HOME = home;
  delete require.cache[require.resolve(PROXY)];
  return require(PROXY) as Proxy;
}

function startFakeDaemon(sockPath: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(REPLY);
      });
    });
    srv.on("error", reject);
    srv.listen(sockPath, () => resolve(srv));
  });
}

describe.skipIf(process.platform === "win32")("hook-proxy SessionStart daemon wait", () => {
  const originalHome = process.env.HOME;
  let home = "";
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
    process.env.HOME = originalHome;
  });

  function fresh() {
    home = mkdtempSync(join(tmpdir(), "sould-proxy-"));
    return { proxy: loadProxy(home), sock: join(home, `.sould-${process.pid}.sock`) };
  }

  it("waits for a daemon that comes up after the hook fired, then forwards the event", async () => {
    const { proxy, sock } = fresh();
    const spawn = vi.fn(() => {
      setTimeout(() => { void startFakeDaemon(sock).then((s) => { server = s; }); }, 600);
    });
    const t0 = Date.now();
    const out = await proxy.run({ event: "session-start", body: "{}", spawnDaemon: spawn, waitMs: 5_000 });
    expect(out).toBe(REPLY);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
  });

  it("fails open with the daemon-down notice once the wait budget is spent", async () => {
    const { proxy } = fresh();
    const spawn = vi.fn();
    const t0 = Date.now();
    const out = await proxy.run({ event: "session-start", body: "{}", spawnDaemon: spawn, waitMs: 400 });
    expect(out).toContain("daemon is unreachable");
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("SessionStart");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(3_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("other events do not wait: they spawn and fail open at once", async () => {
    const { proxy } = fresh();
    const spawn = vi.fn();
    const t0 = Date.now();
    const out = await proxy.run({ event: "user-prompt-submit", body: "{}", spawnDaemon: spawn });
    expect(out).toContain("daemon is unreachable");
    expect(Date.now() - t0).toBeLessThan(300);
    expect(spawn).toHaveBeenCalledTimes(1);
    // Events without an additionalContext slot get an empty object.
    expect(await proxy.run({ event: "stop", body: "{}", spawnDaemon: spawn })).toBe("{}");
  });

  it("retries an endpoint that refuses until the daemon answers", async () => {
    const { proxy, sock } = fresh();
    // A plain file where the socket should be: connecting to it fails.
    writeFileSync(sock, "");
    const spawn = vi.fn(() => {
      setTimeout(() => {
        try { unlinkSync(sock); } catch { /* already gone */ }
        void startFakeDaemon(sock).then((s) => { server = s; });
      }, 500);
    });
    const out = await proxy.run({ event: "session-start", body: "{}", spawnDaemon: spawn, waitMs: 5_000 });
    expect(out).toBe(REPLY);
    expect(spawn).toHaveBeenCalled();
  });

  it("forwards immediately when the daemon is already up", async () => {
    const { proxy, sock } = fresh();
    server = await startFakeDaemon(sock);
    const spawn = vi.fn();
    const t0 = Date.now();
    const out = await proxy.run({ event: "session-start", body: "{}", spawnDaemon: spawn });
    expect(out).toBe(REPLY);
    expect(spawn).not.toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("waitForDaemon returns null at the deadline when nothing appears", async () => {
    const { proxy } = fresh();
    const t0 = Date.now();
    expect(await proxy.waitForDaemon(Date.now() + 300, 50)).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect(proxy.SESSION_START_WAIT_MS).toBeGreaterThan(0);
  });
});
