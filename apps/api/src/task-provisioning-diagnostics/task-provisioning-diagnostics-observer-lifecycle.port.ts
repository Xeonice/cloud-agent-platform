import {
  tryBeginTaskProvisioningDiagnosticObserver,
  tryResumeTaskProvisioningDiagnosticObserver,
  type BeginTaskProvisioningDiagnosticObserverInput,
  type BegunTaskProvisioningDiagnosticObserver,
  type ResumeTaskProvisioningDiagnosticObserverInput,
  type ResumedTaskProvisioningDiagnosticObserver,
} from './task-provisioning-diagnostic-observer.adapter';
import type { TaskProvisioningDiagnosticRecorderPort } from './task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsWriteGatePort } from './task-provisioning-diagnostics-write-gate.port';

/**
 * Observer-lifecycle PORT (collapse-three-collaborator-groups).
 *
 * Beginning and resuming a provisioning diagnostic observer is OWNED here.
 * Callers hand over one input and receive either an observer or `undefined` —
 * the "no observer" result. Whether diagnostics are written is a property of
 * the implementation behind this interface, never a condition the caller
 * evaluates: a closed write gate, an unbound gate, an unbound recorder, a gate
 * that throws, a rejected write and a write that outran its bound all produce
 * that one indistinguishable result. A caller therefore cannot tell an open
 * gate from a closed one, and there is no branch left for it to get wrong.
 *
 * This file is the whole cross-context surface — the interface, the DI token,
 * and (for a consumer with no injector) the implementation itself. The sibling
 * `*.service.ts` adds nothing but the Nest binding.
 */
export const TASK_PROVISIONING_DIAGNOSTICS_OBSERVER_LIFECYCLE =
  'TASK_PROVISIONING_DIAGNOSTICS_OBSERVER_LIFECYCLE';

/** Short evidence-write bound; diagnostics never become admission authority. */
export const TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT_MS = 2_000;

/** Optional binding that overrides the bound above for one composition. */
export const TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT =
  'TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT';

/** An absent, non-integral or non-positive configuration keeps the default. */
export function taskProvisioningDiagnosticWriteTimeoutMs(
  configured?: number,
): number {
  return configured !== undefined &&
    Number.isSafeInteger(configured) &&
    configured > 0
    ? configured
    : TASK_PROVISIONING_DIAGNOSTIC_WRITE_TIMEOUT_MS;
}

/**
 * The two continuations that belong to the ADMISSION caller, not to diagnostics.
 *
 * `tryBegin` owns the bounded write; what an admission path does with the
 * attempt it gets back — remembering it for a legacy cleanup, settling one that
 * arrived after the bound expired — is admission knowledge, so it is supplied
 * per call instead of being reimplemented here. Both are optional: a caller
 * with no continuation still gets the identical begin semantics.
 */
export interface TaskProvisioningDiagnosticObserverBeginContinuation {
  /**
   * Invoked with an attempt that arrived INSIDE the write bound, before
   * `tryBegin` resolves. A throw from here is treated exactly as a failed
   * bounded write: the attempt is handed to {@link onDetachedWrite} and the
   * caller receives the "no observer" result.
   */
  onBegun?(attempt: BegunTaskProvisioningDiagnosticObserver): void;
  /**
   * Invoked when the recorder eventually settles AFTER the bound already
   * detached the write (`undefined` when it settled with no attempt). It runs
   * outside the caller's await: its result is never waited on and a rejection
   * is swallowed, so a detached diagnostic write can never delay or fail the
   * work that moved on without it.
   */
  onDetachedWrite?(
    attempt: BegunTaskProvisioningDiagnosticObserver | undefined,
  ): Promise<void> | void;
}

/** The only surface through which a diagnostic observer is opened or resumed. */
export interface TaskProvisioningDiagnosticsObserverLifecyclePort {
  /**
   * Open evidence for one provisioning attempt. Resolves to the begun observer,
   * or to `undefined` — the "no observer" result — on every unavailable path.
   */
  tryBegin(
    input: BeginTaskProvisioningDiagnosticObserverInput,
    continuation?: TaskProvisioningDiagnosticObserverBeginContinuation,
  ): Promise<BegunTaskProvisioningDiagnosticObserver | undefined>;

  /**
   * Resume the exact persisted attempt a recovery path already proved it owns.
   * Read-only: it never allocates a replacement, and it too answers `undefined`
   * rather than reporting why it could not resume.
   */
  tryResume(
    input: ResumeTaskProvisioningDiagnosticObserverInput,
  ): Promise<ResumedTaskProvisioningDiagnosticObserver | undefined>;
}

/** What the owner needs; every one of them may legitimately be unbound. */
export interface TaskProvisioningDiagnosticsObserverLifecycleCollaborators {
  readonly recorder?: TaskProvisioningDiagnosticRecorderPort;
  readonly writeGate?: TaskProvisioningDiagnosticsWriteGatePort;
  readonly writeTimeoutMs?: number;
}

function withWriteTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * The owner of the diagnostic observer lifecycle.
 *
 * Both boundaries were orchestrator methods until
 * collapse-three-collaborator-groups; they moved here whole, together with the
 * gate reading that used to precede every one of them at the call site. The
 * gate's fail-closed semantics are unchanged, asymmetry included: an unbound
 * gate, an unbound recorder, a closed gate and a gate that THROWS from
 * `isEnabled()` each stop before any recorder call, and each answers with the
 * same "no observer" result — never a partially opened observer, never an
 * exception the caller has to defend against.
 *
 * Every write is bounded and best-effort. A rejected write, a write that outran
 * the bound and a recorder that throws are all swallowed into the same result,
 * so provisioning proceeds identically whether or not evidence was written.
 *
 * A wired application resolves {@link TASK_PROVISIONING_DIAGNOSTICS_OBSERVER_LIFECYCLE}
 * from the container. Constructing this class directly is for a consumer with
 * NO injector: the orchestrator is built POSITIONALLY (with a stub `ModuleRef`,
 * so no DI resolution ever happens) by specs frozen at zero diff that hand it a
 * recorder double and an open write-gate double and then assert on what the
 * recorder received. Their diagnostics keep working from exactly those two
 * hand-passed collaborators, and `writeTimeoutMs` is why a spec-configured
 * bound still bounds the write now that ownership lives here.
 */
export class TaskProvisioningDiagnosticsObserverLifecycle
  implements TaskProvisioningDiagnosticsObserverLifecyclePort
{
  private readonly recorder?: TaskProvisioningDiagnosticRecorderPort;
  private readonly writeGate?: TaskProvisioningDiagnosticsWriteGatePort;
  private readonly writeTimeoutMs: number;

  constructor(
    collaborators: TaskProvisioningDiagnosticsObserverLifecycleCollaborators = {},
  ) {
    this.recorder = collaborators.recorder;
    this.writeGate = collaborators.writeGate;
    this.writeTimeoutMs = taskProvisioningDiagnosticWriteTimeoutMs(
      collaborators.writeTimeoutMs,
    );
  }

  /**
   * Open evidence only when the independent deployment switch and recorder are
   * both available. The gate is sampled once per attempt; any gate/recorder
   * failure leaves admission and provider control flow intact.
   */
  async tryBegin(
    input: BeginTaskProvisioningDiagnosticObserverInput,
    continuation?: TaskProvisioningDiagnosticObserverBeginContinuation,
  ): Promise<BegunTaskProvisioningDiagnosticObserver | undefined> {
    const gate = this.writeGate;
    const recorder = this.recorder;
    if (!gate || !recorder) return undefined;

    let enabled: boolean;
    try {
      enabled = gate.isEnabled();
    } catch {
      return undefined;
    }
    if (!enabled) return undefined;

    const begin = tryBeginTaskProvisioningDiagnosticObserver(recorder, input);
    try {
      const attempt = await withWriteTimeout(
        begin,
        this.writeTimeoutMs,
        'task provisioning diagnostic begin',
      );
      if (attempt) {
        continuation?.onBegun?.(attempt);
      }
      return attempt;
    } catch {
      // A database transaction may commit after this outer evidence timeout.
      // Keep observing that promise without holding the caller: if it
      // eventually returns an identity, the caller's continuation decides what
      // to do with the now-detached attempt so it cannot remain an orphaned
      // active row. Nothing here is awaited by the caller, and a rejecting
      // continuation is swallowed along with the write itself.
      void begin
        .then(async (lateAttempt) => {
          await continuation?.onDetachedWrite?.(lateAttempt);
        })
        .catch(() => undefined);
      return undefined;
    }
  }

  /** Resume terminal-recovery evidence without ever allocating a replacement. */
  async tryResume(
    input: ResumeTaskProvisioningDiagnosticObserverInput,
  ): Promise<ResumedTaskProvisioningDiagnosticObserver | undefined> {
    const gate = this.writeGate;
    const recorder = this.recorder;
    if (!gate || !recorder) return undefined;

    try {
      if (!gate.isEnabled()) return undefined;
      return await withWriteTimeout(
        tryResumeTaskProvisioningDiagnosticObserver(recorder, input),
        this.writeTimeoutMs,
        'task provisioning diagnostic resume',
      );
    } catch {
      return undefined;
    }
  }
}
