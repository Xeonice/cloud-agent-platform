import type {
  SandboxRuntimePreflightCommandDescriptor,
  SandboxRuntimeSetupCommandDescriptor,
  TaskModelLaunchMaterial,
} from '@cap/sandbox';

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

/**
 * Stable task-failure codes a runtime may derive from its own output stream.
 *
 * This vocabulary is intentionally narrow. A runtime reports `expired` only
 * when the provider/CLI explicitly says the credential expired; a generic 401
 * or an invalid credential is `rejected` (or no signal when the evidence is too
 * weak). Lifecycle persistence and user-facing remediation live above this leaf
 * port.
 */
export type RuntimeOutputFailureCode =
  | 'runtime_auth_expired'
  | 'runtime_auth_rejected';

/** Structured runtime failure signal consumed by the shared lifecycle layer. */
export interface RuntimeOutputFailure {
  readonly code: RuntimeOutputFailureCode;
}

/** The default runtime when a task does not specify one. */
export const DEFAULT_RUNTIME_ID: RuntimeId = 'codex';

/**
 * The execution mode a task runs under (add-headless-execution-track).
 * `interactive-pty` = the console's live terminal + operator takeover (resident TUI);
 * `headless-exec` = a programmatic one-shot that runs non-interactively and EXITS on
 * turn completion, so the task reaches a terminal status autonomously. Selected by
 * CONSUMER at task creation (console → interactive-pty; MCP / `/v1` → headless-exec).
 */
export type ExecutionMode = 'interactive-pty' | 'headless-exec';

/**
 * The transcript format a runtime declares. The sandbox transcript-read layer (which
 * owns the parsers) dispatches by this tag — the port stays a dependency-light LEAF and
 * never imports the parsers or `@cap/contracts`.
 */
export type TranscriptFormat = 'codex-rollout' | 'claude-jsonl';

/** Where a runtime's transcript JSONL lands inside the container. */
export interface TranscriptArtifact {
  /** Absolute directory holding the transcript JSONL (e.g. `~/.codex/sessions`). */
  readonly dir: string;
  /** Matches the transcript filename(s) within `dir`; the newest match is read. */
  readonly filenameGlob: RegExp;
}

/**
 * HOW a runtime's transcript source is materialized out of the retained container
 * (unify-transcript-parsers, design D3). This generalizes the read layer's former
 * baked-in "read the single newest JSONL file" assumption into a runtime-declared
 * STRATEGY: the runtime declares the strategy as DATA (alongside WHERE via
 * {@link TranscriptArtifact} and WHAT via {@link TranscriptFormat}); the sandbox read
 * mechanism interprets it. The leaf port owns no read I/O — it only declares the shape.
 *
 * - `single-newest-jsonl` — codex and claude: read the lexicographically-newest file
 *   matching {@link TranscriptArtifact.filenameGlob} under {@link TranscriptArtifact.dir}
 *   and hand the parser a `{ format, jsonl }` source (the prior verbatim behavior).
 *
 * The union is shaped so a FUTURE multi-record runtime (e.g. opencode, which persists
 * session/message/part records rather than one JSONL file) declares a NON-single-JSONL
 * variant — e.g. `{ kind: 'multi-record'; … }` — additively, WITHOUT editing codex/claude.
 */
export type TranscriptReadStrategy = { readonly kind: 'single-newest-jsonl' };

/**
 * The canonical runtime → transcript-format mapping: a registry-free accessor for the
 * value each runtime declares as its `transcriptFormat`. Lets the durable-read path resolve
 * the parser without holding a runtime instance. A unit test asserts it agrees with the
 * runtimes' declared `transcriptFormat` so the two never drift.
 */
export function transcriptFormatForRuntime(
  runtime: RuntimeId | null | undefined,
): TranscriptFormat {
  return runtime === 'claude-code' ? 'claude-jsonl' : 'codex-rollout';
}

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
  /** Required file-backed model material; raw selector text is never provided. */
  readonly model: TaskModelLaunchMaterial;
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
  /** Codex `~/.codex/auth.json` document (official ChatGPT login), written verbatim. */
  readonly authJson?: string;
  /** Claude OAuth subscription token, exported as `CLAUDE_CODE_OAUTH_TOKEN`. */
  readonly oauthToken?: string;
  /**
   * Codex compatible-provider config, ALREADY SSRF-validated by the provider (the
   * async host-safety check is mechanism, not policy — it stays in the provider's
   * material resolution, never in the pure emitter). Written into
   * `~/.codex/config.toml` as a `[model_providers.cap]` block + top-level
   * `model`/`model_provider` (NO auth.json). Mutually exclusive with `authJson`;
   * absent for the unauthenticated/degraded case (unsafe URL or no credential).
   */
  readonly codexCompatible?: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
  };
}


/**
 * One provision-time setup command + its fail-closed policy
 * (refactor-agent-runtime-policy-mechanism). A REAL non-zero exit ALWAYS fails the
 * task closed; `tolerateUnresolvedExit` governs ONLY the unresolved (NaN/absent)
 * exit case — `false` fails closed (codex; claude's prompt write), `true` tolerates
 * it as success (claude's auth write, preserving its `code !== null && code !== 0`).
 */
export interface SandboxSetupCommand {
  readonly command: string;
  readonly tolerateUnresolvedExit: boolean;
  /** Stable diagnostic identity; callers never derive it from `command`. */
  readonly descriptor: SandboxRuntimeSetupCommandDescriptor;
}

/**
 * A runtime-declared image/tooling probe that the provider runs after sandbox
 * readiness and before credential/setup commands. This mirrors Sandbank's
 * provider-scheduler preflight shape at our current single-provider boundary:
 * the runtime declares WHAT capability it needs, while the provider owns HOW the
 * command is executed and how failures abort provisioning.
 */
export interface SandboxRuntimePreflightProbe {
  /** Human-readable plan label; never used as diagnostic identity or failure text. */
  readonly name: string;
  /** Shell command that exits 0 only when the required tool/capability exists. */
  readonly command: string;
  /** Stable diagnostic identity; callers never derive it from `command`. */
  readonly descriptor: SandboxRuntimePreflightCommandDescriptor;
}

/**
 * The runtime's declarative provision-time setup plan. `ok:false` fails the task
 * closed BEFORE any command runs (claude with no token); `ok:true` carries the
 * ORDERED commands the provider runs over the shared exec. The runtime owns NO I/O —
 * it returns commands as data; the provider (mechanism) runs them.
 */
export type SandboxSetupPlan =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly commands: readonly SandboxSetupCommand[] };

/**
 * Inputs a runtime needs to emit its setup commands. `prompt` is the operator task
 * prompt or `null`/empty (the runtime then OMITS the prompt-write command, matching
 * codex's blank-composer / claude's no-prompt behavior — never a no-op write).
 */
export interface SandboxSetupContext {
  readonly taskId: string;
  readonly workspaceDir: string;
  readonly prompt: string | null;
}

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
   * Classify a bounded rolling window of this runtime's raw terminal output.
   *
   * The caller owns buffering across PTY chunks; the runtime owns its provider-
   * specific, pure recognition policy. Returns `null` for generic HTTP errors,
   * quota/rate-limit output, and any text that is not a stable authentication
   * failure signal.
   */
  classifyOutputFailure(rollingOutput: string): RuntimeOutputFailure | null;

  /**
   * Build the in-shell launch line that starts the agent in a DETACHED, NAMED
   * tmux session (`task<taskId>`) with the workspace as cwd. The prompt is
   * delivered via the `$(cat <prompt-file>)` shape (never inlined), so the line
   * is shell-injection-safe for arbitrary free-text prompts.
   */
  buildLaunchLine(ctx: LaunchContext): string;

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
   * Emit the ORDERED provision-time setup commands (creds + config + prompt) as a
   * PURE function of the context + the resolved (SSRF-validated) material — the
   * runtime owns NO I/O; the provider runs the returned commands over the shared
   * exec. `ok:false` fails the task closed before any command (claude with no
   * token); codex degrades to config-only when no credential is configured. The
   * prompt-write command is OMITTED when `ctx.prompt` is null/empty.
   * (refactor-agent-runtime-policy-mechanism — replaces the provider's inline
   * `injectCodexAuth`/`injectTaskPrompt` and the runtime's `injectAuth`.)
   */
  sandboxSetupCommands(
    ctx: SandboxSetupContext,
    material: AuthMaterial | null,
  ): SandboxSetupPlan;

  /**
   * Runtime image/tooling preflight probes. The provider runs these fail-closed
   * before setup/clone so a bad sandbox image fails fast with a concrete missing
   * capability instead of surfacing later as an opaque launch or transcript bug.
   */
  preflightProbes(): readonly SandboxRuntimePreflightProbe[];

  /**
   * Emit the pre-stop HOME-trim commands (drop caches/credentials, KEEP the
   * transcript) the provider runs best-effort (FAIL-OPEN — a trim failure never
   * blocks stop+retain). codex trims `~/.codex` keeping `sessions/`; claude trims
   * `~/.claude` keeping `projects/`. Pure data; the provider owns the exec + the
   * fail-open dispatch (timeout, warn-only). (replaces inline `trimCodexHomeBeforeStop`.)
   */
  preStopTrimCommands(): readonly string[];

  /**
   * The execution modes this runtime supports (add-headless-execution-track). Every
   * runtime supports `interactive-pty`; a runtime that also lists `headless-exec`
   * MUST provide {@link buildHeadlessLine}. The shared task path reads the declared
   * set to decide whether a programmatic (headless) task can be admitted.
   */
  readonly executionModes: ReadonlySet<ExecutionMode>;

  /**
   * Build the in-shell HEADLESS launch line — a non-interactive, exit-on-completion
   * agent invocation (codex `exec --json`, claude `-p --output-format stream-json`),
   * still wrapped in the SAME detached, named session as the interactive line so the
   * liveness poller + boot re-adoption apply unchanged. The process EXITS when the turn
   * finishes → the session-gone path resolves the task to terminal. Present iff
   * `executionModes` includes `headless-exec`.
   */
  buildHeadlessLine?(ctx: LaunchContext): string;

  /**
   * Build the HEADLESS resume launch line that continues a prior session non-interactively
   * (codex `exec resume <id>`, claude `-p --resume <id>`). Declared for completeness/symmetry;
   * the task lifecycle does not wire programmatic multi-turn in this change. Present iff
   * `executionModes` includes `headless-exec`.
   */
  buildResumeLine?(ctx: LaunchContext, prevSessionId: string): string;

  /**
   * Declare WHERE this runtime's transcript JSONL lands inside the container and in WHAT
   * format. The sandbox transcript-read + durable-capture mechanism resolves the dir/glob
   * from here and dispatches the parser by {@link transcriptFormat} — replacing the
   * hardcoded codex `~/.codex/sessions` + `rollout-*.jsonl`. The port owns NO parser.
   */
  transcriptArtifact(ctx: LaunchContext): TranscriptArtifact;
  readonly transcriptFormat: TranscriptFormat;

  /**
   * Declare HOW this runtime's transcript source is read out of the retained container
   * (unify-transcript-parsers, design D3). The sandbox read mechanism reads this STRATEGY
   * (alongside {@link transcriptArtifact}'s WHERE and {@link transcriptFormat}'s WHAT) to
   * materialize the source it hands the parser — generalizing the former baked-in
   * single-newest-file read. codex/claude declare `{ kind: 'single-newest-jsonl' }`
   * verbatim; a future multi-record runtime declares a non-single-JSONL strategy WITHOUT
   * editing them. The leaf port still owns NO read I/O and never imports the parsers.
   */
  readonly readTranscriptSource: TranscriptReadStrategy;
}
