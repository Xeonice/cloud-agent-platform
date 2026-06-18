import { z } from 'zod';
import { RuntimeSchema } from './task.js';

/**
 * Runtime-readiness contract (agent-runtime spec — "Runtime readiness endpoint";
 * design D9).
 *
 * The api exposes a read endpoint (`GET /runtimes`) reporting, per runtime id,
 * whether that runtime is ready to run a task (e.g. its credential is
 * configured), so the create-task dialog can offer or DISABLE a runtime before
 * task creation instead of letting a `claude-code` task fail at launch.
 *
 * SECRET DISCIPLINE: the shape carries BOOLEANS ONLY. It NEVER includes the
 * Claude OAuth token, a codex key, a masked suffix, or any other credential
 * material — only the derived `ready` fact (mirroring the `configured` boolean
 * exposed by the `ClaudeAuthSource` / `EnvCodexAuthSource` ports). This is the
 * read shape the frontend readiness query consumes to gate the runtime selector.
 */

/**
 * Readiness of a single agent runtime: its `id` (the same selector value the
 * task carries — `claude-code` | `codex`) and a single `ready` boolean. No
 * secrets, no token suffix — only whether the runtime is configured/ready.
 */
export const RuntimeReadinessSchema = z.object({
  /** The runtime selector this readiness fact is about (`claude-code` | `codex`). */
  id: RuntimeSchema,
  /**
   * Whether the runtime is configured and ready to launch a task (e.g. its
   * credential is present). Derived from the auth source's `configured` fact;
   * carries no secret material.
   */
  ready: z.boolean(),
});
export type RuntimeReadiness = z.infer<typeof RuntimeReadinessSchema>;

/**
 * The `GET /runtimes` response body: the readiness of every known runtime, one
 * `{ id, ready }` entry per runtime, booleans only. The console reads this to
 * disable an un-ready runtime (with a configure hint) in the create-task dialog.
 */
export const RuntimeReadinessResponseSchema = z.array(RuntimeReadinessSchema);
export type RuntimeReadinessResponse = z.infer<
  typeof RuntimeReadinessResponseSchema
>;
