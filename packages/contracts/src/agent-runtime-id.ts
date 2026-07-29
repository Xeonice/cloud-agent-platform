/**
 * THE declaration of which agent runtimes exist.
 *
 * This list was previously restated independently in four places, and nothing
 * compared them: the schema in `task.ts`, a hand-written union in the api's
 * `agent-runtime.port.ts`, the api's actual registry registrations, and a fourth
 * union in the console — which re-declared the set despite already depending on
 * this package. The registry's own docstring claimed "registering a third runtime
 * needs no edit here" while narrowing to the hand-written union three lines below
 * it, and the schema here carried a comment promising to stay "byte-for-byte in
 * sync" with the registry. Both promises were prose. Adding a runtime meant
 * finding all four, with nothing pointing at them and nothing failing if one was
 * missed.
 *
 * Everything that depends on which runtimes exist derives from here. A surface
 * that legitimately admits MORE, or covers only a SUBSET, states that as an
 * explicit extension of — or subset of — this list, so the widening or narrowing
 * is visible rather than hidden in a separately maintained array.
 *
 * This mirrors {@link SANDBOX_PROVIDER_FAMILIES} deliberately: the two axes had
 * the same defect, and only the provider one had been fixed, which is why only
 * the provider axis could admit a third implementation.
 */
export const AGENT_RUNTIME_IDS = ['claude-code', 'codex'] as const;

export type AgentRuntimeId = (typeof AGENT_RUNTIME_IDS)[number];

/**
 * The runtime applied when a create request omits `runtime` and when an existing
 * persisted task carries no `runtime` value (additive-nullable column). Existing
 * tasks and omitted requests therefore read back as `codex`.
 *
 * Declared here rather than beside the schema so that the api's own default and
 * this one cannot be two independent literals asserted against two independent
 * copies of the union.
 */
export const DEFAULT_AGENT_RUNTIME_ID = 'codex' as const satisfies AgentRuntimeId;
