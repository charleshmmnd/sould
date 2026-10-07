#!/usr/bin/env node
/**
 * Re-seed the Tier-0 soul rows from the soul document.
 *
 * Why (2026-10-07): seeded soul rows used to be joined with "; ", which the
 * injector could not split, so only the first entry of each section ever
 * reached the model. soul.ts now joins entries on SOUL_ENTRY_SEPARATOR and
 * the injector rotates whole entries. Seeding normally happens only when the
 * soul evolves; this script does it now, so the running daemon serves the
 * new row shape without waiting for the next evolution.
 *
 * Safe: seedSoulAsCoreMemory creates the new rows first and soft-archives the
 * old ones (never deletes), the same path every evolution takes.
 *
 * Usage
 *   node scripts/reseed-soul-core-memory.mjs            # dry-run: show what would be seeded
 *   node scripts/reseed-soul-core-memory.mjs --apply    # seed
 *
 * The daemon-managed SurrealDB listens on a daemon-chosen port with the
 * credentials in <cacheDir>/surreal-cred.json, so point the script at it the
 * way config.ts already allows: SURREAL_URL=ws://127.0.0.1:<port>/rpc with
 * SURREAL_USER and SURREAL_PASS from that file (never echo them).
 */
import { parsePluginConfig } from "../dist/engine/config.js";
import { SurrealStore } from "../dist/engine/surreal.js";
import { getSoul, seedSoulAsCoreMemory } from "../dist/engine/soul.js";
import { SOUL_ENTRY_SEPARATOR } from "../dist/engine/soul-text.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const config = parsePluginConfig({});
  if (!config?.surreal?.url) {
    console.error("[reseed-soul] FATAL: no Surreal URL resolvable from config.");
    process.exit(2);
  }
  const store = new SurrealStore(config.surreal, { skipSupervisorRegister: true });
  const ok = await store.initialize();
  if (!ok || !store.isAvailable()) {
    console.error("[reseed-soul] FATAL: store did not initialize.");
    process.exit(2);
  }
  try {
    const soul = await getSoul(store);
    if (!soul) {
      console.log("[reseed-soul] no soul document; nothing to seed.");
      return;
    }
    const sections = {
      working_style: soul.working_style?.length ?? 0,
      self_observations: soul.self_observations?.length ?? 0,
      earned_values: soul.earned_values?.length ?? 0,
    };
    console.log(`[reseed-soul] APPLY=${APPLY} sections:`, sections, `separator=${JSON.stringify(SOUL_ENTRY_SEPARATOR)}`);
    const active = await store.queryFirst(
      `SELECT meta::id(id) AS id, string::len(text) AS chars, string::contains(text, $sep) AS new_shape FROM core_memory WHERE category = 'soul' AND (active = true OR active IS NONE)`,
      { sep: SOUL_ENTRY_SEPARATOR },
    );
    console.log("[reseed-soul] active soul rows before:", active);
    if (!APPLY) {
      console.log("[reseed-soul] dry-run; pass --apply to seed.");
      return;
    }
    const seeded = await seedSoulAsCoreMemory(soul, store);
    const after = await store.queryFirst(
      `SELECT meta::id(id) AS id, string::len(text) AS chars, string::contains(text, $sep) AS new_shape FROM core_memory WHERE category = 'soul' AND (active = true OR active IS NONE)`,
      { sep: SOUL_ENTRY_SEPARATOR },
    );
    console.log(`[reseed-soul] seeded ${seeded} rows; active soul rows after:`, after);
  } finally {
    await store.close?.().catch?.(() => {});
  }
}

main().catch((e) => { console.error("[reseed-soul] FAILED:", e?.message ?? e); process.exit(1); });
