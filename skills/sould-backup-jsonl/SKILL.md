---
name: sould-backup-jsonl
description: "Activate when the user wants to export sould for import into a non-SurrealDB system — Postgres + pgvector, Neo4j, OpenSearch, a custom store, or any system that ingests JSON. Triggers on \"export sould to JSON\", \"dump sould for ingestion\", \"migrate sould off SurrealDB\". Use this skill when the destination is not SurrealDB; for SurrealDB-to-SurrealDB use `sould-backup-native`."
---

Body in sould DB. Call `mcp__plugin_sould_sould__get_skill_body` with `name="sould-backup-jsonl"` to load full instructions.
