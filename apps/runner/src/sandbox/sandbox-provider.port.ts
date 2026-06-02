import type { SandboxMode } from '@cap/contracts';

/**
 * Runner-side `SandboxProvider` port (sandbox-provider-port 9.1, integration 9.1b).
 *
 * The runner's execution-provisioning call site (the codex spawn) depends on
 * THIS PORT to decide the `--sandbox <mode>` flag, rather than hardcoding the
 * mode. A future OS-isolating implementation can report a stricter mode through
 * the same port with no change to the provisioning caller.
 *
 * `SandboxMode` is the single-source-of-truth enum from `@cap/contracts`; the
 * orchestrator's api-side port (`apps/api/src/sandbox/sandbox-provider.port.ts`)
 * restates the same union for its own self-contained build. The two stay in
 * lockstep via the contracts enum.
 */
export type { SandboxMode };

export interface SandboxProvider {
  /** The execution sandbox mode this provider enforces, as an explicit capability. */
  getSandboxMode(): SandboxMode;
}

/**
 * Minimal Docker runner sandbox provider: reports `danger-full-access` because
 * the inner Codex bubblewrap/seccomp sandbox collapses inside a container (the
 * Docker plane is the deploy plane, not the per-task execution sandbox — the
 * ephemeral session-scoped credentials are the real safety boundary). Mirrors
 * the orchestrator-side `DockerSandboxProvider`.
 */
export class DockerRunnerSandboxProvider implements SandboxProvider {
  getSandboxMode(): SandboxMode {
    return 'danger-full-access';
  }
}

/**
 * Maps a {@link SandboxMode} to the `codex --sandbox <mode>` argument tokens the
 * interactive spawn appends. The provisioning caller (task-entry) injects these
 * so the sandbox mode is provider-driven, not baked into the call site (9.1b).
 */
export function sandboxModeArgs(mode: SandboxMode): readonly string[] {
  return ['--sandbox', mode];
}
