import type { SandboxMode } from '@cap/contracts';

/**
 * SandboxProvider port (Track 9: sandbox-provider-port, design D9).
 *
 * The concrete OS-isolating execution sandbox is deferred behind this port so
 * that callers depend on the abstraction rather than a specific implementation.
 * The port exposes the execution sandbox *mode* as an explicit capability,
 * which lets the first (weak) Docker implementation be an honest, swappable
 * placeholder rather than a baked-in assumption — and lets a future
 * OS-isolating implementation (for example a Claude Code sandbox-runtime) be
 * dropped in by satisfying this same interface, with no consumer changes.
 *
 * NOTE: `SandboxMode` is owned by `@cap/contracts` (`SandboxModeSchema` /
 * `SandboxMode`, contracts task 2.7) as the single source of truth. This port
 * imports and re-exports that type rather than re-declaring it (VR.12), so there
 * is exactly one definition shared across api, runner, and web — no drift.
 *
 * Execution sandbox mode values, exposed by a `SandboxProvider` as a capability:
 * - `read-only`           — the sandbox may read the workspace but not mutate it.
 * - `workspace-write`     — the sandbox may mutate its own workspace, nothing more.
 * - `danger-full-access`  — no OS-level isolation of the inner agent (see the
 *                           Docker implementation for why this is forced there).
 */
export type { SandboxMode };

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
 * Consumers (terminal-execution / agent-events / runner-dialback / guardrails
 * provisioning call sites) MUST depend on this interface rather than on any
 * concrete implementation, so a stricter, OS-isolating implementation can be
 * swapped in later without modifying them.
 */
export interface SandboxProvider {
  /**
   * The effective execution sandbox mode this provider enforces, surfaced as an
   * explicit capability. A future OS-isolating implementation can report a
   * stricter mode (for example `workspace-write` or `read-only`) through this
   * same method, and existing consumers honor it without modification.
   */
  getSandboxMode(): SandboxMode;

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
}

/**
 * DI token for the {@link SandboxProvider} port (integration 9.1b).
 *
 * Consumers inject the provider by this token (`@Inject(SANDBOX_PROVIDER)`)
 * rather than referencing a concrete class, so the bound implementation can be
 * swapped (Docker today, an OS-isolating impl later) with no consumer change.
 */
export const SANDBOX_PROVIDER = Symbol('SandboxProvider');
