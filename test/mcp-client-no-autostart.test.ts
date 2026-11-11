import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOSTART } from "../src/mcp-client/index.js";

// Importing the client module must not start a client. Before 0.10.16 it did,
// and a test run told the developer's live daemon to step down.
describe("mcp client module under test", () => {
  it("does not start a client when imported by a test", () => {
    expect(AUTOSTART).toBe(false);
  });

  it("the guard is in the source the release ships", () => {
    const src = readFileSync(join(__dirname, "..", "src", "mcp-client", "index.ts"), "utf8");
    expect(src).toMatch(/if \(AUTOSTART\) \{\s*main\(\)/);
  });
});
