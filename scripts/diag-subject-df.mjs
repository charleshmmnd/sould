#!/usr/bin/env node
// Read-only: how many memories mention each term, and how long the count takes.
// Used to calibrate the subject brief (src/engine/subject-brief.ts).
// Usage: node scripts/diag-subject-df.mjs term1 term2 ...
import { parsePluginConfig } from "../dist/engine/config.js";
import { SurrealStore } from "../dist/engine/surreal.js";

const store = new SurrealStore(parsePluginConfig({}).surreal);
await store.initialize();
const total = (await store.queryFirst(`SELECT count() AS n FROM memory GROUP ALL`))[0]?.n ?? 0;
console.log(`memories: ${total}`);
for (const term of process.argv.slice(2)) {
  const t0 = Date.now();
  const rows = await store.queryFirst(
    `SELECT count() AS n FROM memory WHERE text @1@ $t AND (status = 'active' OR status IS NONE) GROUP ALL`, { t: term });
  const ms = Date.now() - t0;
  const t1 = Date.now();
  const latest = await store.queryFirst(
    `SELECT text, created_at FROM memory WHERE text @1@ $t AND (status = 'active' OR status IS NONE) ORDER BY created_at DESC LIMIT 1`, { t: term });
  console.log(`${String(rows[0]?.n ?? 0).padStart(5)}  ${String(ms).padStart(4)}ms count ${String(Date.now() - t1).padStart(4)}ms latest  ${term}  | ${String(latest[0]?.created_at ?? "").slice(0, 10)} ${String(latest[0]?.text ?? "").slice(0, 70).replace(/\s+/g, " ")}`);
}
process.exit(0);
