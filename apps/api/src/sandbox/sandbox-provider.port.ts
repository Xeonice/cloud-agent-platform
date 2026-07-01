import {
  SANDBOX_PROVIDER_CAPABILITIES,
  SANDBOX_EXECUTION_MODES,
  type SandboxConnection,
  type SandboxDeliverWorkspaceArgs,
  type SandboxDeliverWorkspaceResult,
  type SandboxExecutionMode,
  type SandboxProviderCapability,
  type SandboxProviderPort,
  type SandboxSelectedRunPort,
  type SandboxProvisionContext,
  type SelectedSandboxRun,
} from '@cap/sandbox';
import type { RuntimeId } from '../agent-runtime/agent-runtime.port';
import type { TranscriptSource } from './transcript-source';
import type { CloneSpec } from './provision-lookup.port';

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
 * NOTE: the sandbox execution mode vocabulary is owned by `@cap/sandbox` so
 * local and cloud provider adapters share one scheduler-facing contract.
 *
 * Informational execution sandbox mode values reported by a `SandboxProvider`:
 * - `read-only`           — the sandbox may read the workspace but not mutate it.
 * - `workspace-write`     — the sandbox may mutate its own workspace, nothing more.
 * - `danger-full-access`  — no OS-level isolation of the inner agent reported.
 */
export type SandboxMode = SandboxExecutionMode;
export { SANDBOX_PROVIDER_CAPABILITIES };
export type {
  SandboxConnection,
  SandboxProviderCapability,
  SelectedSandboxRun,
};

export type ProvisionContext = SandboxProvisionContext<CloneSpec>;

/**
 * The set of all valid `SandboxMode` values, ordered from most to least
 * restrictive. Useful for validation and for reasoning about whether an
 * implementation reports a stricter mode than another.
 */
export const SANDBOX_MODES: readonly SandboxMode[] = [
  ...SANDBOX_EXECUTION_MODES,
];

/**
 * Port abstraction over the per-task execution sandbox.
 *
 * The core provider contract lives in `@cap/sandbox`; this API-side alias binds
 * it to the API's concrete `CloneSpec`, `RuntimeId`, and `TranscriptSource`
 * types while preserving the existing Nest DI token and local import path.
 */
export type SandboxProvider = SandboxProviderPort<
  CloneSpec,
  RuntimeId,
  TranscriptSource
> &
  SandboxSelectedRunPort;

export type DeliverWorkspaceArgs = SandboxDeliverWorkspaceArgs;

export type DeliverWorkspaceResult = SandboxDeliverWorkspaceResult;

/**
 * DI token for the {@link SandboxProvider} port (integration 9.1b).
 *
 * Consumers inject the provider by this token (`@Inject(SANDBOX_PROVIDER)`)
 * rather than referencing a concrete class. The bound implementation is the
 * sandbox provider-center router assembled in `sandbox.module.ts`.
 */
export const SANDBOX_PROVIDER = Symbol('SandboxProvider');
