import type { AgentRuntimeId } from '@cap/contracts';
import type { AgentRuntime, RuntimeId } from '@/agent-runtime/agent-runtime.port';

/**
 * Compile-fail fixtures for runtime registration.
 *
 * A runtime test can prove that today's registrations match today's declaration.
 * Only the compiler can prove that TOMORROW's declared runtime cannot ship
 * unregistered — which is exactly what used to happen: the registry took a
 * positional array, so a declared-but-unregistered runtime compiled cleanly and
 * failed at task launch with `no runtime registered for "..."`.
 *
 * These assignments deliberately stay behind `@ts-expect-error`. If
 * `AGENT_RUNTIME_IMPLEMENTATIONS` is ever weakened to a `Partial` or to an
 * index-signature shape — which would restore the silent-gap behaviour this
 * change removed — the directives become unused and the ordinary API typecheck
 * fails. The fixture cannot be defeated by relaxing the thing it guards.
 */

type RuntimeImplementations = Readonly<Record<RuntimeId, AgentRuntime>>;

declare const withoutClaudeCode: Omit<RuntimeImplementations, 'claude-code'>;

// @ts-expect-error Every declared runtime must have a registered implementation.
const missingRegistration: RuntimeImplementations = withoutClaudeCode;
void missingRegistration;

declare const withoutAny: Omit<RuntimeImplementations, keyof RuntimeImplementations>;

// @ts-expect-error An empty registration table cannot satisfy the declaration.
const emptyRegistrations: RuntimeImplementations = withoutAny;
void emptyRegistrations;

/**
 * A `Partial` is the specific weakening that would make a missing registration
 * legal again, so it is named here rather than left implicit.
 */
declare const partialRegistrations: Partial<RuntimeImplementations>;

// @ts-expect-error Registration must be total, not partial.
const partialIsNotTotal: RuntimeImplementations = partialRegistrations;
void partialIsNotTotal;

/**
 * The api's `RuntimeId` must remain the contract's declaration rather than a
 * re-declared union. If someone reintroduces a local literal union, these two
 * stop being mutually assignable and the directives below become unused — the
 * ordinary typecheck then fails, which is the intended alarm.
 */
declare const declared: AgentRuntimeId;
const apiIdIsTheDeclaration: RuntimeId = declared;
void apiIdIsTheDeclaration;

declare const apiId: RuntimeId;
const declarationIsTheApiId: AgentRuntimeId = apiId;
void declarationIsTheApiId;

/** An identifier outside the declaration is not a runtime id. */
declare const arbitrary: string;

// @ts-expect-error Runtime ids come from the declaration, not from free strings.
const unmodelledRuntime: RuntimeId = arbitrary;
void unmodelledRuntime;
