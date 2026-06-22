import type { SandboxMode } from '@cap/contracts';
import type { RuntimeId } from '../agent-runtime/agent-runtime.port';
import type { TranscriptSource } from './transcript-source';

/**
 * SandboxProvider port (sandbox-provider-port, design D).
 *
 * The concrete per-task execution sandbox is deferred behind this port so that
 * callers depend on the abstraction rather than a specific implementation. Under
 * the connect-in model the provider creates an AIO container per task and
 * `provision()` returns an addressable {@link SandboxConnection} the caller dials
 * by container name — there is no dial-back to authenticate. A future
 * OS-isolating implementation can be dropped in by satisfying this same
 * interface, with no consumer changes.
 *
 * The port also exposes the execution sandbox *mode* via `getSandboxMode()`, but
 * that mode is INFORMATIONAL only: under AIO Sandbox the real isolation boundary
 * is the container (`seccomp=unconfined` + network isolation), not the reported
 * mode. See `getSandboxMode()` below.
 *
 * NOTE: `SandboxMode` is owned by `@cap/contracts` (`SandboxModeSchema` /
 * `SandboxMode`) as the single source of truth. This port imports and re-exports
 * that type rather than re-declaring it (VR.12), so there is exactly one
 * definition shared across consumers — no drift.
 *
 * Informational execution sandbox mode values reported by a `SandboxProvider`:
 * - `read-only`           — the sandbox may read the workspace but not mutate it.
 * - `workspace-write`     — the sandbox may mutate its own workspace, nothing more.
 * - `danger-full-access`  — no OS-level isolation of the inner agent reported.
 */
export type { SandboxMode };

/**
 * An addressable handle to a provisioned per-task execution sandbox.
 *
 * Under the connect-in model the orchestrator is the WebSocket *client*: it
 * provisions an AIO container and dials it **by container name** on the private
 * `cap-net` network (no host port is published). `provision()` returns this
 * handle so the caller can reach the sandbox without any further lookup.
 *
 * - `baseUrl` — the sandbox HTTP API root, `http://cap-aio-<taskId>:8080`.
 * - `wsUrl`   — the sandbox terminal WebSocket,
 *               `ws://cap-aio-<taskId>:8080/v1/shell/ws`.
 */
export interface SandboxConnection {
  /** The task this sandbox was provisioned for. */
  readonly taskId: string;
  /** Sandbox HTTP API root, `http://cap-aio-<taskId>:8080`. */
  readonly baseUrl: string;
  /** Sandbox terminal WebSocket, `ws://cap-aio-<taskId>:8080/v1/shell/ws`. */
  readonly wsUrl: string;
}

/**
 * Inputs a provider needs to provision a task's execution sandbox. The
 * workspace root and image configuration are read from the provider's own
 * configuration (environment); only the per-task identity is task-specific and
 * passed here.
 */
export interface ProvisionContext {
  /** The task whose sandbox should be provisioned. */
  readonly taskId: string;
}

/**
 * The set of all valid `SandboxMode` values, ordered from most to least
 * restrictive. Useful for validation and for reasoning about whether an
 * implementation reports a stricter mode than another.
 */
export const SANDBOX_MODES: readonly SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;

/**
 * Port abstraction over the per-task execution sandbox.
 *
 * Consumers (terminal-execution / agent-events / guardrails provisioning call
 * sites) MUST depend on this interface rather than on any concrete
 * implementation, and consume the returned {@link SandboxConnection} handle, so
 * a stricter, OS-isolating implementation can be swapped in later without
 * modifying them.
 */
export interface SandboxProvider {
  /**
   * The execution sandbox mode this provider reports, surfaced as an
   * INFORMATIONAL capability only.
   *
   * Under AIO Sandbox the real isolation boundary is the per-task container —
   * `seccomp=unconfined` plus network isolation (`cap-net`, no host port) — NOT
   * the reported mode, so consumers MUST treat this value as observability
   * metadata rather than something that drives execution behavior. The method
   * is retained for compatibility; a future OS-isolating implementation may
   * still report a stricter mode (for example `workspace-write` or
   * `read-only`) through it.
   */
  getSandboxMode(): SandboxMode;

  /**
   * Provision the execution sandbox for a task and return an addressable
   * {@link SandboxConnection} handle. Called when the guardrails semaphore
   * admits a task to `running`.
   *
   * Under the connect-in model the provider creates the per-task sandbox
   * container and the orchestrator (the WS *client*) dials it **by container
   * name** on the private `cap-net` network — there is no dial-back to
   * authenticate, so no per-task token is supplied or returned. The returned
   * handle (`baseUrl` + `wsUrl`) is sufficient for the caller to open the
   * sandbox terminal WebSocket without any further lookup.
   *
   * Implementations MUST be idempotent for an already-provisioned task,
   * returning a handle equivalent to the original provision.
   */
  provision(ctx: ProvisionContext): Promise<SandboxConnection>;

  /**
   * Tear down the running sandbox for the given task (VR.2). Called by the
   * guardrails forced-failure path (deadline / idle / circuit-breaker) to stop
   * or kill the running sandbox container so it does not continue consuming
   * resources after the task is force-failed.
   *
   * Implementations MUST be idempotent — calling this for a task that has
   * already exited or was never started is a safe no-op.
   *
   * @param taskId - The task whose sandbox should be torn down.
   */
  teardownSandbox(taskId: string): Promise<void>;

  /**
   * Read the runtime's transcript source out of a settled, RETAINED sandbox for
   * read-only history replay (session-sandbox-retention D3; generalized by
   * unify-transcript-parsers D3). Returns a {@link TranscriptSource} — the discriminated
   * union the parser registry consumes — produced via the runtime-declared
   * `readTranscriptSource` strategy: codex/claude declare the single-newest-JSONL read,
   * so the returned source is `{ format, jsonl }` whose `jsonl` is byte-identical to the
   * prior lexicographically-newest-file read. Returns `null` when no source is present —
   * the container was reaped/expired, the path is missing, or the agent never produced a
   * transcript. Implementations MUST NOT restart the sandbox, MUST scope the read to the
   * transcript only (never exporting any credential file), and MUST NOT throw into the
   * caller (a no-container / no-match / unreadable read resolves to an ABSENT source).
   *
   * @param taskId - The task whose retained sandbox transcript to read.
   */
  readRolloutFromContainer(
    taskId: string,
    runtimeId?: RuntimeId | null,
  ): Promise<TranscriptSource | null>;

  /**
   * Whether the per-task retained sandbox still EXISTS (running or settled). Lets
   * the history endpoint distinguish an aged-out/reaped session (`expired`) from
   * one whose sandbox exists but produced no transcript (`empty`). Never throws.
   *
   * @param taskId - The task whose sandbox existence to check.
   */
  sandboxExists(taskId: string): Promise<boolean>;

  /**
   * IN-SANDBOX result delivery (add-multi-forge-task-delivery): commit the
   * working-tree diff, create `branch`, and push it to `origin` over the sandbox
   * exec channel. The `authHeader` (from `forge.cloneAuthHeader`) rides
   * `git -c http.extraHeader` only (the clone discipline — never persisted). A
   * clean working tree yields `{hadChanges:false}`; any git failure is returned
   * as `error` (the caller fails-open). This is git only — the change-request
   * HTTP call runs platform-side via the Forge port, so the token never enters
   * the sandbox for that.
   */
  deliverWorkspaceChanges(
    taskId: string,
    args: DeliverWorkspaceArgs,
  ): Promise<DeliverWorkspaceResult>;
}

/** Inputs for {@link SandboxProvider.deliverWorkspaceChanges}. */
export interface DeliverWorkspaceArgs {
  /** The `git -c http.extraHeader` value (from `forge.cloneAuthHeader`). */
  readonly authHeader: string;
  /** The branch to create + push (`cap/task-<taskId>`). */
  readonly branch: string;
  /** The commit message (file-injected in-sandbox — never on the shell line). */
  readonly commitMessage: string;
}

/** Result of {@link SandboxProvider.deliverWorkspaceChanges}. */
export interface DeliverWorkspaceResult {
  /** False when the working tree had no diff (→ `no_changes`, no branch/push). */
  readonly hadChanges: boolean;
  /** The pushed commit sha, or null when no commit / unresolved. */
  readonly commitSha: string | null;
  /** A scrubbed failure reason, or null on success. */
  readonly error: string | null;
}

/**
 * DI token for the {@link SandboxProvider} port (integration 9.1b).
 *
 * Consumers inject the provider by this token (`@Inject(SANDBOX_PROVIDER)`)
 * rather than referencing a concrete class, so the bound implementation can be
 * swapped (`AioSandboxProvider` today, an OS-isolating impl later) with no
 * consumer change.
 */
export const SANDBOX_PROVIDER = Symbol('SandboxProvider');
