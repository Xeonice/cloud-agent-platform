import { z } from 'zod';

/**
 * SandboxProvider sandbox-mode capability (sandbox-provider-port spec, D9).
 *
 * The `SandboxProvider` port exposes the execution sandbox mode as an explicit
 * capability so the concrete OS-isolating implementation can be deferred and
 * swapped without changing callers. The first impl (minimal Docker) reports
 * `danger-full-access` because the inner Codex bubblewrap/seccomp sandbox
 * collapses inside a container.
 */
export const SandboxModeSchema = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;
