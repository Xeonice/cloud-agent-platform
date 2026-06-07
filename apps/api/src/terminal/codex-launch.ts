/**
 * codex launch contract (aio-codex-prompt-autostart) — the single source of
 * truth, shared by the provider (which WRITES the task-prompt file into the
 * sandbox at provision time) and the bridge (which REFERENCES that file in the
 * in-shell codex launch line). Kept as a dependency-free LEAF module so importing
 * it pulls nothing else into either side's compile graph.
 */

/**
 * Absolute path of the injected task-prompt file inside the sandbox. The provider
 * base64-decodes `task.prompt` into this file under the `gem`-owned `~/.codex`;
 * the bridge launch line reads it via `"$(cat <path>)"` to pre-fill codex's
 * composer. Must stay in lockstep on both sides — hence one constant.
 */
export const CODEX_PROMPT_FILE_PATH = '/home/gem/.codex/task-prompt.txt';

/**
 * True when `argv` carries a flag that DISABLES codex's approval hooks
 * (`-s` / `--yolo` / `bypass-approvals`) — launching with these would fail OPEN
 * on approvals. The bridge refuses such an argv.
 *
 * This inspects ONLY the fixed launch flags. The operator prompt text is NEVER
 * part of `argv` (it rides the injected file referenced via `"$(cat …)"`), so a
 * prompt that merely MENTIONS `--yolo`/`-s`/`bypass-approvals` can never trip
 * this guard.
 */
export function argvDisablesHooks(argv: string): boolean {
  return /(^|\s)-s(\s|$)|bypass-approvals|(^|\s)--yolo(\s|$)/.test(argv);
}

/**
 * Build the in-shell codex launch line that PRE-FILLS the composer with the
 * task prompt (when one was injected) WITHOUT inlining the prompt text into the
 * command line.
 *
 * The prompt is read from {@link CODEX_PROMPT_FILE_PATH} into a shell variable
 * and passed as codex's positional `[PROMPT]` only when non-empty:
 *
 *   P="$(cat <file> 2>/dev/null)"; if [ -n "$P" ]; then <argv> "$P"; else <argv>; fi
 *
 * Why this shape:
 * - `"$(cat file)"` captured into `$P` then expanded as `"$P"` passes arbitrary
 *   prompt text (quotes, backticks, `$`, newlines) as EXACTLY ONE argument with
 *   no re-evaluation — shell-injection-safe for free-text prompts.
 * - A missing/empty file (`2>/dev/null` + `[ -n "$P" ]`) launches codex with NO
 *   positional argument — a blank composer — rather than an empty-string arg,
 *   the documented degradation when there is no prompt or injection was skipped.
 * - The prompt text never appears in the literal command, so the hook-disabling
 *   guard ({@link argvDisablesHooks}) — which inspects `argv` — cannot false-
 *   positive on prompt content.
 */
export function buildCodexLaunchLine(
  baseArgv: string,
  promptFilePath: string = CODEX_PROMPT_FILE_PATH,
): string {
  return (
    `P="$(cat ${promptFilePath} 2>/dev/null)"; ` +
    `if [ -n "$P" ]; then ${baseArgv} "$P"; else ${baseArgv}; fi`
  );
}
