---
name: sould-backup-semantic
description: "Activate when the user wants to send the sould knowledge core (concepts, memories, skills, reflections, artifacts, soul) to another agent or system WITHOUT the transcript volume (turns, retrieval_outcomes, metrics). Triggers on \"transfer knowledge to ilaqrum\", \"share sould brain\", \"extract just the concepts\", \"give my graph to another agent\". For full snapshot use `sould-backup-native`; for non-SurrealDB targets use `sould-backup-jsonl`."
---

Body in sould DB. Call `mcp__plugin_sould_sould__get_skill_body` with `name="sould-backup-semantic"` to load full instructions.
