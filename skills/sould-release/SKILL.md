---
name: sould-release
description: End-to-end procedural skill for shipping a new sould version. Bumps all 6 version surfaces atomically, commits, tags, pushes, and verifies CI green with the correct exit-code pattern. Use BEFORE running `git push` on a release commit, not after.
---

Body in sould DB. Call `mcp__plugin_sould_sould__get_skill_body` with `name="sould-release"` to load full instructions.
