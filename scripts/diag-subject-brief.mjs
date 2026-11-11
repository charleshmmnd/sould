#!/usr/bin/env node
// Read-only: show the subject brief a tool call would get from the live graph.
// Usage: node scripts/diag-subject-brief.mjs "<bash command or text>" ...
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parsePluginConfig } from "../dist/engine/config.js";
import { SurrealStore } from "../dist/engine/surreal.js";
import { SessionState } from "../dist/engine/state.js";
import { buildSubjectBrief } from "../dist/engine/subject-brief.js";

if (!process.env.SURREAL_USER) {
  try {
    const c = JSON.parse(readFileSync(`${homedir()}/.sould/surreal-cred.json`, "utf8"));
    process.env.SURREAL_USER = c.user; process.env.SURREAL_PASS = c.pass;
  } catch { /* fall through to config defaults */ }
}
const store = new SurrealStore(parsePluginConfig({}).surreal);
await store.initialize();
const session = new SessionState("diag", "diag");
for (const command of process.argv.slice(2)) {
  const t0 = Date.now();
  const brief = await buildSubjectBrief(store, session, "Bash", { command });
  console.log(`\n$ ${command}\n(${Date.now() - t0} ms) ${brief ?? "no brief"}`);
}
process.exit(0);
