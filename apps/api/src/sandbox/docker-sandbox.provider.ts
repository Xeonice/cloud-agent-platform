import type { SandboxMode, SandboxProvider } from './sandbox-provider.port.js';

/**
 * Minimal Docker `SandboxProvider` (Track 9: sandbox-provider-port, design D9).
 *
 * This is the first, deliberately weak implementation of the {@link SandboxProvider}
 * port. It reports `danger-full-access`.
 *
 * WHY `danger-full-access` IS FORCED:
 *   Running the Codex CLI inside a Docker container forces
 *   `--sandbox danger-full-access` because the inner Codex OS sandbox
 *   (bubblewrap + seccomp) collapses inside the container: the very kernel
 *   primitives Codex relies on to isolate itself (user namespaces, mount
 *   namespaces, seccomp-bpf filtering) are not reliably available — or are
 *   stripped — within an unprivileged container, so the inner sandbox cannot
 *   establish its isolation boundary and effectively degrades to full access.
 *
 * CONSEQUENCE — Docker is the deploy plane, NOT the execution sandbox:
 *   Because the inner per-task OS sandbox collapses, Docker here serves as the
 *   *platform deploy plane* (how the orchestrator/runner are shipped and run),
 *   and is explicitly NOT the per-task execution sandbox. The real per-task
 *   safety boundary in this configuration is therefore the ephemeral,
 *   session-scoped credentials destroyed at session end (runner-dialback-and-creds),
 *   not OS-level isolation of the agent process.
 *
 * PATH FORWARD:
 *   A future OS-isolating implementation (for example a Claude Code
 *   sandbox-runtime) can satisfy the same {@link SandboxProvider} port and
 *   report a stricter mode, with no changes required in the port's consumers.
 */
export class DockerSandboxProvider implements SandboxProvider {
  /**
   * Reports the effective sandbox mode. Always `danger-full-access` for the
   * Docker implementation — see the class-level documentation for why the inner
   * Codex bubblewrap/seccomp sandbox collapses inside a container.
   */
  getSandboxMode(): SandboxMode {
    return 'danger-full-access';
  }

  /**
   * No-op teardown for the Docker provider (VR.2).
   *
   * In the Docker-as-deploy-plane model, each runner process is the sandbox;
   * the runner tears itself down when its task ends (or when the orchestrator
   * stops sending it work). A future OS-isolating implementation (e.g. a
   * per-task microVM or container-per-task model) would stop/kill the
   * container here. For now this is a documented, intentional no-op so that
   * the guardrails `forceFail` path compiles and the port contract is satisfied.
   */
  async teardownSandbox(_taskId: string): Promise<void> {
    // No-op: the Docker provider does not manage per-task sandbox containers
    // from the orchestrator side. The runner process tears itself down.
  }
}
