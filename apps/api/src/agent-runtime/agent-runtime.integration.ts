/**
 * AgentRuntime INTEGRATION layer (add-claude-code-runtime, Track 3 wiring).
 *
 * Track 2 shipped the dependency-light {@link AgentRuntime} PORT
 * (`agent-runtime.port.ts`) and the two concrete runtimes ({@link CodexRuntime},
 * {@link ClaudeCodeRuntime}) plus the plain {@link AgentRuntimeRegistry}. Those
 * are the leaf, unit-tested contract and MUST stay untouched.
 *
 * The Track-3 CONSUMERS (the AIO provider, the PTY client, the terminal gateway)
 * are NOT leaf modules — they already reach the sandbox HTTP surface directly and
 * they only ever know a `taskId` (never the task's `runtime` value, never a
 * `LaunchContext`). This module is the thin INTEGRATION bridge between those two
 * worlds:
 *
 *   - it exposes a Nest-injectable {@link RuntimeRegistry} (bound under
 *     {@link RUNTIME_REGISTRY}) whose `resolveForTask(taskId)` reads the task's
 *     persisted `runtime` column and returns the matching leaf port runtime;
 *   - it provides the small shared adapters the consumers use to talk to the single
 *     port directly: {@link toPortExec} (a `(command) => {exitCode, output}` closure
 *     → the port's object `{stdout, code}` exec) and {@link sessionIdForTask} (the
 *     stable `--session-id` uuid for the port `LaunchContext`).
 *
 * refactor-agent-runtime-policy-mechanism (step 5) collapsed the two parallel
 * `AgentRuntime` interfaces into ONE — this module re-exports the port's
 * `AgentRuntime` and the registry hands consumers the leaf runtimes DIRECTLY; the
 * former `RuntimeAdapter` translation layer is gone. No behavior is added here.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { AgentRuntimeRegistry } from './agent-runtime.registry';
import { CodexRuntime } from './codex-runtime';
import { ClaudeCodeRuntime } from './claude-code-runtime';
import type {
  AgentRuntime as PortAgentRuntime,
  RuntimeId,
  SandboxExec as PortSandboxExec,
} from './agent-runtime.port';
import {
  PROVISION_LOOKUP,
  type ProvisionLookup,
} from '../sandbox/provision-lookup.port';

/**
 * DI token the integration registry is bound under. The provider
 * (`@Inject(RUNTIME_REGISTRY)`, 3.1) and the terminal gateway (optional, 3.2)
 * resolve the SAME instance through it.
 */
export const RUNTIME_REGISTRY = Symbol('RuntimeRegistry');

/** The captured `{exitCode, output}` of one sandbox `/v1/shell/exec` command. */
export interface SandboxExecResult {
  /** The command exit code (NaN when it could not be resolved → fail-closed). */
  readonly exitCode: number;
  /** The captured stdout/stderr/output of the command. */
  readonly output: string;
}

/**
 * The narrow exec closure the consumers hand a runtime: runs ONE command over the
 * sandbox's `/v1/shell/exec` surface and returns its `{exitCode, output}`.
 */
export type SandboxExec = (command: string) => Promise<SandboxExecResult>;

/** Per-task launch context the consumers build for {@link AgentRuntime.buildLaunchLine}. */
export interface LaunchContext {
  readonly taskId: string;
  /** The detached tmux session name `task<taskId>` (consumer-supplied, advisory). */
  readonly sessionName: string;
  /** Absolute cloned-workspace directory the agent runs in. */
  readonly workspaceDir: string;
}

/**
 * The runtime interface the consumers depend on IS the port's
 * {@link PortAgentRuntime} (refactor step 5: the two parallel `AgentRuntime`
 * interfaces collapsed into ONE). Re-exported here under the name `AgentRuntime` so
 * existing consumer imports keep resolving — the `RuntimeAdapter` translation layer
 * is gone; the registry hands consumers the leaf port runtimes directly, and the
 * consumers (pty client / provider) build the port's `LaunchContext` + map its
 * `ExitSignal` themselves via the small exported `toPortExec`/`sessionIdForTask`.
 */
export type { AgentRuntime } from './agent-runtime.port';

/** The registry the consumers inject under {@link RUNTIME_REGISTRY}. */
export interface RuntimeRegistry {
  /** Resolve a runtime by id (codex by default; throws on an unknown id). */
  resolve(id?: RuntimeId | null): PortAgentRuntime;
  /** Resolve the runtime selected by the task's persisted `runtime` column. */
  resolveForTask(taskId: string): Promise<PortAgentRuntime>;
}

/** Adapt a consumer {@link SandboxExec} closure to the leaf {@link PortSandboxExec}. */
export function toPortExec(exec: SandboxExec): PortSandboxExec {
  return {
    async exec(command: string): Promise<{ stdout: string; code: number | null }> {
      const { exitCode, output } = await exec(command);
      return { stdout: output, code: Number.isNaN(exitCode) ? null : exitCode };
    },
  };
}

/**
 * A stable per-task session uuid (the claude `--session-id`). Derived
 * deterministically from `taskId` so the launch line and the exit-detection /
 * transcript reads agree on the same `<uuid>.jsonl`, WITHOUT threading new state
 * through the consumers. Shaped as a v4-style uuid string (claude only requires a
 * valid uuid). Codex ignores it.
 */
export function sessionIdForTask(taskId: string): string {
  // FNV-1a over the taskId → 32 hex chars, formatted as a uuid. Deterministic and
  // dependency-free; collisions across distinct tasks are irrelevant (the file is
  // scoped to the task's own sandbox).
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x5bd1e995;
  for (let i = 0; i < taskId.length; i += 1) {
    const c = taskId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 1) | 1), 0x01000193) >>> 0;
  }
  const hex = (
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0') +
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0')
  ).slice(0, 32);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * Nest-injectable {@link RuntimeRegistry}: builds the leaf {@link AgentRuntimeRegistry}
 * from the two concrete runtimes, reads each task's persisted `runtime` value via the
 * {@link ProvisionLookup} port, and hands consumers the leaf port runtimes DIRECTLY
 * (refactor step 5: the `RuntimeAdapter` translation layer is gone — consumers depend
 * on the single port interface and build the port `LaunchContext` / map its
 * `ExitSignal` themselves via {@link toPortExec} / {@link sessionIdForTask}).
 */
@Injectable()
export class IntegrationRuntimeRegistry implements RuntimeRegistry {
  private readonly logger = new Logger(IntegrationRuntimeRegistry.name);
  private readonly registry = new AgentRuntimeRegistry([
    new CodexRuntime(),
    new ClaudeCodeRuntime(),
  ]);

  constructor(
    @Optional()
    @Inject(PROVISION_LOOKUP)
    private readonly lookup?: ProvisionLookup,
  ) {}

  resolve(id?: RuntimeId | null): PortAgentRuntime {
    return this.registry.resolve(id);
  }

  async resolveForTask(taskId: string): Promise<PortAgentRuntime> {
    return this.registry.resolve(await this.readTaskRuntime(taskId));
  }

  /** Read the task's persisted `runtime` value (codex default when unavailable). */
  private async readTaskRuntime(taskId: string): Promise<RuntimeId | null> {
    const reader = this.lookup as
      | (ProvisionLookup & { getTaskRuntime?: (id: string) => Promise<string | null> })
      | undefined;
    if (typeof reader?.getTaskRuntime !== 'function') return null;
    try {
      const value = await reader.getTaskRuntime(taskId);
      return value === 'claude-code' || value === 'codex' ? value : null;
    } catch (err) {
      this.logger.warn(
        `could not read runtime for task ${taskId} (defaulting to codex): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
}
