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

/**
 * The detached named tmux session for a task, `task<taskId>` (survive-api-redeploy
 * D1). Codex runs INSIDE this session so it is a child of the container's tmux
 * daemon — not a foreground child of the WS-spawned shell — and therefore KEEPS
 * RUNNING when the orchestrator's `/v1/shell/ws` connection closes (api restart /
 * operator disconnect). The same name is what the boot re-adoption pass and the
 * liveness poller use to find / attach / probe the running codex, so it MUST be a
 * pure deterministic function of `taskId` shared on all sides — hence one helper.
 */
export function detachedSessionName(taskId: string): string {
  return `task${taskId}`;
}

/**
 * Build the launch line that starts codex in a DETACHED, NAMED tmux session
 * (survive-api-redeploy D1). It WRAPS — does not replace — the existing in-shell
 * launch line from {@link buildCodexLaunchLine}:
 *
 *   tmux new-session -d -s task<taskId> -c /home/gem/workspace '<codex launch line>'
 *
 * Why this shape:
 * - `-d` creates the session DETACHED, so codex becomes a child of the container
 *   tmux daemon. When the WS-spawned shell that issued this command dies (the WS
 *   closes on api restart / operator disconnect), the detached session and codex
 *   KEEP RUNNING — the survive-api-redeploy sidestep, verified by spike #2.
 * - `-s task<taskId>` names the session deterministically so it can be probed
 *   (`tmux has-session`), attached (`tmux attach`), and re-adopted on boot.
 * - `-c /home/gem/workspace` sets the session's working directory to the cloned
 *   task repo, matching the `-C /home/gem/workspace` the codex argv already used
 *   (the WS shell's own cwd is HOME, not the clone dir).
 * - The codex launch line is passed as ONE single-quoted argument so tmux runs it
 *   verbatim inside the session. The inner line still reads the prompt from
 *   {@link CODEX_PROMPT_FILE_PATH} via `"$(cat …)"` and passes it positionally —
 *   the prompt-injection contract is unchanged WITHIN the detached session.
 *
 * Single-quote safety: the inner line is fixed launch text (no operator prompt is
 * ever inlined — the prompt rides the injected file), so it contains no single
 * quote; `'<line>'` is therefore a clean single-quoted shell word. The
 * hook-disabling guard ({@link argvDisablesHooks}) still inspects ONLY the fixed
 * `argv`, so wrapping in tmux changes nothing for that guard.
 */
export function buildDetachedCodexLaunchLine(
  taskId: string,
  baseArgv: string,
  promptFilePath: string = CODEX_PROMPT_FILE_PATH,
  workspaceDir = '/home/gem/workspace',
): string {
  return wrapInDetachedSession(
    taskId,
    buildCodexLaunchLine(baseArgv, promptFilePath),
    workspaceDir,
  );
}

/**
 * Wrap an agent's in-shell launch `innerLine` in the DETACHED, NAMED tmux session
 * `task<taskId>` (refactor-agent-runtime-policy-mechanism: the SHARED launch
 * MECHANISM). Every runtime's launch line uses this identical wrapper — the
 * agent-specific part is the `innerLine` the runtime supplies (its argv/env +
 * `$(cat <prompt-file>)` prompt delivery). The single-quoted inner is fixed launch
 * text (the operator prompt rides the injected file, never the argv), so it carries
 * no single quote and `'<line>'` stays a clean single-quoted shell word.
 */
export function wrapInDetachedSession(
  taskId: string,
  innerLine: string,
  workspaceDir = '/home/gem/workspace',
): string {
  return `tmux new-session -d -s ${detachedSessionName(taskId)} -c ${workspaceDir} '${innerLine}'`;
}

/**
 * Absolute path of the per-task sentinel the detached HEADLESS wrapper writes the agent's
 * exit code into (fix-headless-execution-container-gaps). A headless agent runs AS the
 * detached tmux session's command, so once it exits the session ends and its exit code is
 * unrecoverable from the AIO main shell (`/v1/shell/wait` waits on a different shell; a fresh
 * `echo $?` sees nothing). The wrapper captures `$?` here and the pty client reads it to
 * resolve `succeeded`/`failed`. One constant, both sides.
 */
export function headlessExitFile(taskId: string): string {
  return `/home/gem/.cap-headless-${taskId}.exit`;
}

/**
 * Like {@link wrapInDetachedSession}, but for a HEADLESS one-shot: it appends
 * `; echo $? > <headlessExitFile>` INSIDE the single-quoted inner so the agent's REAL exit
 * code survives the session ending. The appended segment carries no single quote, so the
 * "inner is a clean single-quoted shell word" invariant still holds. `$?` is the agent's exit
 * because the echo is the next command after it; the write completes before the shell exits
 * and the session is gone, so the sentinel exists by the time `tmux has-session` reports gone.
 */
export function wrapHeadlessDetachedSession(
  taskId: string,
  innerLine: string,
  workspaceDir = '/home/gem/workspace',
): string {
  return `tmux new-session -d -s ${detachedSessionName(taskId)} -c ${workspaceDir} '${innerLine}; echo $? > ${headlessExitFile(taskId)}'`;
}

/**
 * The `tmux has-session` liveness/exit probe command for a task's detached session
 * (refactor: the SINGLE has-session command builder). codex's `detectExit` and the
 * pty client's abnormal-death watchdog / attach-existence check all build the probe
 * here, so the `tmux has-session -t task<taskId>` form lives in ONE place.
 */
export function buildHasSessionCommand(taskId: string): string {
  return `tmux has-session -t ${detachedSessionName(taskId)}`;
}
