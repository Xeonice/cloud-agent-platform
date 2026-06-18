import {
  DEFAULT_RUNTIME_ID,
  type AgentRuntime,
  type RuntimeId,
} from './agent-runtime.port';

/**
 * AgentRuntime registry (add-claude-code-runtime, design D1).
 *
 * Resolves the {@link AgentRuntime} implementation for a task by the task's
 * `runtime` value. The orchestrator/admission path calls {@link resolve} with the
 * (possibly null/absent) task runtime and gets back the matching runtime — codex
 * when the task carries no runtime, claude-code when it asks for it. This is the
 * ONLY place the shared scaffolding maps an agent identity to behavior; everything
 * downstream depends on the {@link AgentRuntime} port, never on a concrete class.
 *
 * Kept as a plain class (not a Nest provider here) so the leaf module stays
 * dependency-free and unit-testable; the DI module that constructs it lives with
 * the consumers (Track 3 wiring), built from the two runtime instances.
 */
export class AgentRuntimeRegistry {
  private readonly byId: ReadonlyMap<RuntimeId, AgentRuntime>;

  /**
   * @param runtimes the available runtime implementations. Each MUST report a
   *   distinct {@link AgentRuntime.id}; a duplicate id is a wiring bug and throws
   *   at construction so it surfaces immediately, not at task launch.
   */
  constructor(runtimes: readonly AgentRuntime[]) {
    const map = new Map<RuntimeId, AgentRuntime>();
    for (const runtime of runtimes) {
      if (map.has(runtime.id)) {
        throw new Error(
          `AgentRuntimeRegistry: duplicate runtime id "${runtime.id}"`,
        );
      }
      map.set(runtime.id, runtime);
    }
    this.byId = map;
  }

  /**
   * Resolve the runtime for a task's `runtime` value. A null/undefined value
   * (legacy tasks, omitted field) resolves the {@link DEFAULT_RUNTIME_ID} (codex),
   * matching the contract/Prisma default so existing rows keep running codex. An
   * UNKNOWN/unregistered id throws — the caller (admission) treats that as a
   * fail-closed create-time rejection rather than launching the wrong agent.
   */
  resolve(runtime: RuntimeId | null | undefined): AgentRuntime {
    const id: RuntimeId = runtime ?? DEFAULT_RUNTIME_ID;
    const found = this.byId.get(id);
    if (!found) {
      throw new Error(`AgentRuntimeRegistry: no runtime registered for "${id}"`);
    }
    return found;
  }

  /** True when a runtime is registered for `id` (used by readiness probes). */
  has(id: RuntimeId): boolean {
    return this.byId.has(id);
  }

  /** The registered runtime ids, for enumeration (e.g. the readiness endpoint). */
  ids(): RuntimeId[] {
    return [...this.byId.keys()];
  }
}
