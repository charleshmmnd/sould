/**
 * PreToolUse hook handler.
 *
 * Tool budget gating: tracks calls against the adaptive limit,
 * soft-interrupts on overshoot, blocks redundant recall calls.
 */
import type { GlobalPluginState } from "../engine/state.js";
import { type HookResponse } from "../http-api.js";
/** Directory a `git push` in `command` runs in: the last `cd <dir>` before it, else `cwd`. */
export declare function pushRepoDir(command: string, cwd: string): string;
/**
 * Whether the Stop hook still owes a push reminder after this Bash command.
 * `pending` is the current flag. A push leaves the reminder owed unless the
 * same command already verifies after it; a later command clears it. A repo
 * with GitHub Actions needs a `gh run` check, one without needs only proof the
 * push landed (ls-remote, status -sb). The reminder used to fire on every push
 * and blocked twice on 2026-10-09 after pushes already verified in repos with
 * no workflows at all.
 */
export declare function pushReminderOwed(command: string, pending: {
    owed: boolean;
    needsCi: boolean;
}, hasWorkflows: (cmd: string) => boolean): {
    owed: boolean;
    needsCi: boolean;
};
export declare function handlePreToolUse(state: GlobalPluginState, payload: Record<string, unknown>): Promise<HookResponse>;
