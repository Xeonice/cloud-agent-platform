import { RunnerMinutesLedger, type RunningInterval } from './runner-minutes';

/**
 * Running-interval accounting PORT (extract-runner-minutes-ledger).
 *
 * The in-process ledger of task running intervals is OWNED by one provider in
 * this directory (`runner-minutes-ledger.service.ts`, registered under
 * {@link RUNNER_MINUTES_PORT} by `runner-minutes.module.ts`). Every other
 * bounded context — the orchestrator that writes intervals, the metrics reader
 * that derives minutes from them — reaches that owner through THIS interface
 * and that token, never through the concrete `RunnerMinutesLedger` class and
 * never through a forwarding accessor on someone else's service.
 *
 * The surface is deliberately the three methods the ledger already had. It
 * carries runner-accounting vocabulary only (`RunningInterval`, `taskId`): the
 * reason a task started or stopped running belongs to the caller, not here.
 */
export interface RunnerMinutesPort {
  /** Record that `taskId` entered RUNNING now. Idempotent while it is open. */
  recordStart(taskId: string): void;
  /** Record that `taskId` left RUNNING now. A no-op if it never started. */
  recordEnd(taskId: string): void;
  /** Snapshot of observed intervals — closed first, then the still-open ones. */
  intervals(): RunningInterval[];
}

/** DI token the owner is provided under, and the only way to inject it. */
export const RUNNER_MINUTES_PORT = 'RUNNER_MINUTES_PORT';

/**
 * Builds a standalone ledger for a service instance that has NO injector — the
 * injector-less fallback, and nothing else.
 *
 * It exists for exactly one reason. `apps/api/src/guardrails/guardrails.service.spec.ts`
 * is frozen at zero diff by the guardrails capability, and it constructs the
 * orchestrator POSITIONALLY at `:94` (`new GuardrailsService(...)` with `{} as ModuleRef`)
 * — so no DI resolution ever happens there — then reflectively reads
 * `internals.runnerMinutes.intervals()` at 7 assertion sites (`:1380`, `:3021`,
 * `:3078`, `:3136`, `:3207`, `:3280`, `:3347`; the identifier occurs 14 times
 * because each site also carries a type annotation). Those reads must land on a
 * working ledger without an injector, which is what this factory supplies.
 *
 * Its only production call site is the initializer of the orchestrator's
 * FALLBACK backing member. In a booted application `onModuleInit` resolves the
 * owner into a SEPARATE member, and the orchestrator's private `runnerMinutes`
 * getter prefers that resolved owner: the fallback is then BYPASSED, not
 * replaced in place, and it goes on recording nothing for the rest of the
 * process. Do not call this from anywhere else — a second call site would be a
 * second route to owning ledger state.
 *
 * It returns the REAL recording semantics, never a no-op double: all 7 frozen
 * assertions above assert the ABSENCE of open intervals, so a ledger that
 * recorded nothing would satisfy every one of them vacuously while accounting
 * nothing at all.
 */
export function createDetachedRunnerMinutes(): RunnerMinutesPort {
  return new RunnerMinutesLedger();
}
