/**
 * AgentRuntime port (add-claude-code-runtime, design D1).
 *
 * Execution was codex-only and codex-hard-coded across six seams: launch argv,
 * auth injection, DSR-gated autosubmit, `tmux has-session` exit detection,
 * transcript capture, and the `$(cat)` prompt delivery. This port extracts those
 * seams so a SECOND agent (Claude Code) can plug in WITHOUT the codex-specifics
 * leaking into the shared scaffolding (the per-task AIO container, the detached
 * tmux session, the `/v1/shell/ws` PTY client, the asciicast capture/replay, the
 * liveness poller, and boot re-adoption all stay runtime-agnostic — they branch on
 * agent identity ONLY through this port).
 *
 * The two implementations — {@link CodexRuntime} and `ClaudeCodeRuntime` — are
 * resolved per task by the task's `runtime` value via the runtime registry. The
 * codex extraction is behavior-preserving: `CodexRuntime` is today's logic moved
 * behind the port with no functional change.
 *
 * This is a dependency-light LEAF module: it pulls in only the codex-launch leaf
 * helpers, never Nest/Prisma/provider internals, so either side's compile graph
 * stays small and the runtimes are unit-testable in plain node.
 */

/**
 * The set of runtime identifiers. Kept as a local literal union (NOT imported
 * from `@cap/contracts`) so this leaf module compiles standalone; it is the same
 * `{ 'claude-code' | 'codex' }` the contract `RuntimeSchema` enumerates and the
 * Prisma `Task.runtime` column persists. `codex` is the default when a task
 * carries no runtime.
 */
export type RuntimeId = 'codex' | 'claude-code';

/** The default runtime when a task does not specify one. */
export const DEFAULT_RUNTIME_ID: RuntimeId = 'codex';

/**
 * A minimal shell-exec handle into a provisioned sandbox: runs ONE command over
 * the sandbox's `/v1/shell/exec` surface and returns its captured output + exit
 * code. The runtime depends on this narrow abstraction (NOT on the concrete
 * `fetch(<baseUrl>/v1/shell/exec)` the provider/pty client use today) so the
 * provisioning transport can evolve without a runtime change, and so the runtimes
 * are testable with an in-memory fake.
 */
export interface SandboxExec {
  /**
   * Run `command` in the sandbox shell. Returns the trimmed stdout and the exit
   * code (or null when the exit code could not be resolved). Implementations
   * SHALL NOT throw on a non-zero exit — that is reported via `code`; they MAY
   * throw on a transport failure (the caller decides whether that is fatal).
   */
  exec(command: string): Promise<{ stdout: string; code: number | null }>;
}

/**
 * Per-task context the runtime needs to build its launch line: the task id (the
 * detached tmux session is `task<taskId>`) and the absolute clone-dir the agent
 * runs in. Extra per-runtime knobs (e.g. Claude's `--session-id` uuid) ride on
 * the optional fields rather than widening the shared call sites.
 */
export interface LaunchContext {
  /** The task id; the detached tmux session name is `task<taskId>`. */
  readonly taskId: string;
  /** Absolute working directory inside the sandbox (the cloned task repo). */
  readonly workspaceDir: string;
  /**
   * Stable per-task session uuid, supplied by the caller. Codex ignores it;
   * Claude threads it through `--session-id` so the runtime can locate the
   * `<session-id>.jsonl` transcript for exit detection.
   */
  readonly sessionId?: string;
}

/**
 * Resolved credential material a runtime injects into a sandbox before launch.
 * Deliberately a thin union of OPTIONAL fields so one shape serves both agents
 * (codex writes `authJson`; claude sets an env token) without a per-runtime
 * material type leaking into the shared provisioning call site. `null`/absent
 * means "no credential configured" — the runtime decides whether that fails
 * closed (claude) or degrades to unauthenticated (codex, preserving today's
 * behavior).
 */
export interface AuthMaterial {
  /** Codex `~/.codex/auth.json` document, written verbatim into the sandbox. */
  readonly authJson?: string;
  /** Claude OAuth subscription token, exported as `CLAUDE_CODE_OAUTH_TOKEN`. */
  readonly oauthToken?: string;
}

/**
 * The auth-injection outcome reported back to the provisioning caller. `ok=false`
 * with a `reason` is the FAIL-CLOSED signal (e.g. a `claude-code` task with no
 * token configured) so the orchestrator can mark the task failed with a distinct
 * reason BEFORE any unauthenticated agent process is started; `ok=true` covers
 * both "injected" and "degraded to unauthenticated" (codex), matching today's
 * codex behavior where a missing auth.json only logs a warning.
 */
export type InjectAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Declarative terminal-startup POLICY (refactor-agent-runtime-policy-mechanism).
 * The SHARED pty mechanism (`AioPtyClient`) reads this to decide whether to reply to
 * the crossterm startup DSR with a synthetic CPR and whether to inject a single
 * zero-touch Enter once output quiesces. The MECHANISM is identical for every
 * runtime; only these PARAMETERS are agent-specific, so the shared scaffolding never
 * branches on agent identity — it reads the declared policy.
 *   - codex:       `{ replyToStartupDSR: true,  promptSubmit: 'cr-on-quiesce' }`
 *     (its positional prompt only PRE-FILLS the composer; the CR submits it)
 *   - claude-code: `{ replyToStartupDSR: false, promptSubmit: 'none' }`
 *     (it auto-runs its positional prompt — no DSR handshake, no submit key)
 */
export interface TerminalStartup {
  /** Reply to the crossterm startup DSR (`\x1b[6n`) with a synthetic CPR. */
  readonly replyToStartupDSR: boolean;
  /** Whether/how the pre-filled prompt is submitted after startup. */
  readonly promptSubmit: 'none' | 'cr-on-quiesce';
  /** Output-quiescence window (ms) before the CR, for `promptSubmit: 'cr-on-quiesce'`. */
  readonly quiesceMs?: number;
}

/**
 * The exit-detection verdict. `done` resolves the task to a terminal state;
 * `running` means keep polling. Codex resolves `done` the instant its detached
 * tmux session is GONE; Claude resolves `done` when the transcript's last
 * `assistant` event carries `stop_reason == "end_turn"` (the process itself stays
 * alive idling, so the runtime kills the session as a side effect to let the
 * shared session-gone path resolve cleanly).
 */
export type ExitSignal =
  | { readonly status: 'running' }
  | { readonly status: 'done' };

/**
 * A structured archival transcript record, parsed from the per-runtime JSONL.
 * Kept generic (the raw record plus its detected type/role) because the two
 * agents' JSONL schemas differ; the shared byte-stream asciicast remains the
 * PRIMARY replay source and this is the OPTIONAL structured side-channel.
 */
export interface TranscriptRecord {
  /** The record's `type` (e.g. `assistant`, `user`, `system`, `attachment`). */
  readonly type: string;
  /** The role when present (`assistant`/`user`/…), else undefined. */
  readonly role?: string;
  /** The raw parsed JSON object for the record. */
  readonly raw: Record<string, unknown>;
}

/**
 * The transcript-capture result. The shared byte-stream asciicast (captured by
 * the unchanged terminal pipeline) is ALWAYS the primary replay source; the
 * `records` array is the OPTIONAL structured archival read of the per-runtime
 * JSONL (empty when the runtime has no structured source or the read failed —
 * never a hard error, a best-effort read of a frozen sandbox yields "what was
 * parseable").
 */
export interface TranscriptCapture {
  /** Parsed structured records from the per-runtime JSONL (possibly empty). */
  readonly records: readonly TranscriptRecord[];
}

/**
 * The AgentRuntime port: the agent-specific execution seams behind one interface.
 * Every member is pure-ish (no Nest, no Prisma): declarative policy data
 * ({@link TerminalStartup}) plus functions over the narrow {@link SandboxExec}
 * handle, so a runtime is fully unit-testable and the shared scaffolding never
 * branches on agent identity — it reads the declared policy.
 */
export interface AgentRuntime {
  /** The runtime identity; matches the task's `runtime` value. */
  readonly id: RuntimeId;

  /**
   * Build the in-shell launch line that starts the agent in a DETACHED, NAMED
   * tmux session (`task<taskId>`) with the workspace as cwd. The prompt is
   * delivered via the `$(cat <prompt-file>)` shape (never inlined), so the line
   * is shell-injection-safe for arbitrary free-text prompts.
   */
  buildLaunchLine(ctx: LaunchContext): string;

  /**
   * Inject the agent's credential + config into the provisioned sandbox via the
   * `exec` handle BEFORE launch. Returns {@link InjectAuthResult}: `ok:false`
   * fails the task closed with a distinct reason (claude with no token); `ok:true`
   * covers injected OR degraded-to-unauthenticated (codex, preserving behavior).
   */
  injectAuth(
    exec: SandboxExec,
    material: AuthMaterial | null,
  ): Promise<InjectAuthResult>;

  /**
   * Declarative terminal-startup policy the SHARED pty mechanism reads (replaces the
   * old `autoSubmit(pty,ctx)` observer, which handed the runtime a PTY event loop the
   * mechanism actually owns — the source of the v0.6.0 leak). codex declares the
   * DSR-reply + cr-on-quiesce; claude declares neither.
   */
  readonly terminalStartup: TerminalStartup;

  /**
   * Decide whether the agent's turn is complete. Codex checks the detached tmux
   * session is gone; Claude tails the `--session-id` JSONL for the last
   * `assistant` event with `stop_reason == "end_turn"` and, on `done`, kills the
   * session so the shared session-gone path resolves the task.
   */
  detectExit(exec: SandboxExec, ctx: LaunchContext): Promise<ExitSignal>;

  /**
   * Read the per-runtime structured transcript as an OPTIONAL archival source.
   * The shared byte-stream asciicast is the primary replay; this returns the
   * parsed JSONL records (empty on absence/failure, never throws).
   */
  captureTranscript(
    exec: SandboxExec,
    ctx: LaunchContext,
  ): Promise<TranscriptCapture>;
}
