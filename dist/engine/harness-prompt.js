/**
 * Harness-generated prompts (0.10.6).
 *
 * Claude Code delivers some turns through the UserPromptSubmit hook that no
 * human typed: a background task finishing (`<task-notification>`), a
 * subagent hand-back (`<agent-message ...>` inside a `<system-reminder>`),
 * the "[SYSTEM NOTIFICATION - NOT USER INPUT]" banner, and the /loop
 * sentinel. On 2026-10-15 these were ingested as user turns and retrieved
 * against like any other prompt: retrieval keyed off tool ids and temp
 * paths, returned noise, and the stored notifications themselves came back
 * on later prompts as 70%-relevant "past turns" (340 of 2,848 user turns on
 * the live graph were notifications).
 *
 * The test is positional: a notification BEGINS with one of these markers.
 * A person who pastes a notification into their own question starts with
 * their own words, and that prompt is still theirs.
 */
const LEADING_WRAPPER = /^(?:\s*<system-reminder\b[^>]*>\s*)+/i;
const MARKERS = [
    /^<task-notification\b/i,
    /^<agent-message\b/i,
    /^\[SYSTEM NOTIFICATION\b/i,
    /^\[Subagent hand-back\]/i,
    /^<<autonomous-loop/i,
    /^Another Claude session sent a message while you were working/i,
];
/** True when `text` is a prompt the harness generated, not the user. */
export function isHarnessNotification(text) {
    if (!text)
        return false;
    const body = text.replace(LEADING_WRAPPER, "").trimStart();
    return MARKERS.some((re) => re.test(body));
}
