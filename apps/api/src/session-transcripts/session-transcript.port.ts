/**
 * The transcript-capture port (collapse-three-collaborator-groups, N3).
 *
 * The orchestrator's terminal chokepoints must persist a task's rollout WHILE
 * the sandbox still exists. Before this change they reached the capture service
 * by re-providing the concrete `SessionTranscriptService` the tasks module
 * exported, which forced `GuardrailsModule -> TasksModule` into the module graph
 * purely to reach one collaborator. This port is that reach, declared where the
 * capture owner lives: a DI token, the one method the orchestrator calls, and a
 * no-op standing in wherever no capture provider is wired.
 *
 * The no-op is what lets the orchestrator inject this NON-optionally and stop
 * branching on whether a collaborator exists — an absent provider becomes an
 * implementation that captures nothing, not an `undefined` every call site has
 * to guard.
 */

import type {
  RuntimeId,
  TranscriptFormat,
} from '@/agent-runtime/agent-runtime.port';

/**
 * Outcome flag for {@link SessionTranscriptCapturePort.capture} (and for the
 * owning service's backfill path, which converges on the same statuses).
 *
 * `'no-rollout'` — nothing to archive (the agent never wrote one, or it was
 * already reaped); `'error'` — a read/write/index step failed and was logged and
 * swallowed; `'captured'` — the archive and its index row are durable.
 */
export type CaptureStatus = 'captured' | 'no-rollout' | 'error';

/**
 * Durable transcript capture, as the orchestrator needs it.
 *
 * BEST-EFFORT by contract: an implementation logs and swallows its own failures
 * and resolves to a status flag rather than throwing, so an awaiting terminal
 * path is never blocked or failed by a capture problem.
 */
export interface SessionTranscriptCapturePort {
  /**
   * Persist the task's rollout to durable storage while its container is still
   * present (gzipped archive + index upsert). Resolves to the outcome flag.
   */
  capture(taskId: string): Promise<CaptureStatus>;
}

/** DI token the capture owner is provided under. */
export const SESSION_TRANSCRIPT_CAPTURE = 'SESSION_TRANSCRIPT_CAPTURE';

/**
 * The stand-in for a composition with no capture provider (a focused unit
 * context, or a deployment that omits the capture module). It captures nothing
 * and says so with the same flag a real capture returns when there was no
 * rollout — so a caller reads one contract, never `undefined`.
 */
export const NOOP_SESSION_TRANSCRIPT_CAPTURE: SessionTranscriptCapturePort = {
  async capture(): Promise<CaptureStatus> {
    return 'no-rollout';
  },
};

/**
 * The slice of the agent-runtime registry the capture path reads: a task's
 * runtime declares the transcript format its rollout is written in, and capture
 * resolves it from that declaration rather than re-deriving it from the
 * runtime's identity.
 *
 * Declared HERE, narrow, rather than importing the tasks context's registry
 * interface: the capture owner left `tasks/` precisely so it would not depend on
 * it, and importing `tasks.service.ts` back would re-create the very edge this
 * move removes (as a directory cycle, which the module-layout gate rejects
 * outright). The composition binds this token to the SAME `@Global()` runtime
 * registry instance the tasks context binds its own token to, so there is one
 * registry and two consumer-local names for it.
 */
export interface TranscriptRuntimeRegistry {
  resolve(runtime: RuntimeId | null | undefined): {
    readonly transcriptFormat: TranscriptFormat;
  };
}

/** DI token {@link TranscriptRuntimeRegistry} is supplied under. */
export const TRANSCRIPT_RUNTIME_REGISTRY = 'TRANSCRIPT_RUNTIME_REGISTRY';
