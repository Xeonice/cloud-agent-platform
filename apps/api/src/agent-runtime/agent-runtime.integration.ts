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
 *     persisted `runtime` column and returns the matching runtime;
 *   - it adapts the leaf port surface (object {@link PortSandboxExec} returning
 *     `{stdout, code}`, `LaunchContext`, `ExitSignal`, `AuthMaterial`) to the
 *     narrow shape the consumers were written against (a `(command) => {exitCode,
 *     output}` exec closure, a `{taskId, sessionName, workspaceDir}` launch
 *     context, a `{done}` exit decision, a `{taskId, workspaceDir, prompt}` inject
 *     context), wrapping each {@link AgentRuntime} in a {@link RuntimeAdapter}.
 *
 * No behavior is added beyond what Track 2 already implements: the adapter only
 * translates shapes and wires the claude credential/prompt the provider delegates
 * (task 3.1). Codex stays byte-identical (the adapter forwards to the unchanged
 * CodexRuntime, and the consumers' own inline codex autosubmit/exit machinery is
 * preserved by `autoSubmit()===true` / `trimBeforeStop` absent for codex).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { AgentRuntimeRegistry } from './agent-runtime.registry';
import { CodexRuntime } from './codex-runtime';
import { ClaudeCodeRuntime } from './claude-code-runtime';
import type {
  AgentRuntime as PortAgentRuntime,
  AuthMaterial,
  LaunchContext as PortLaunchContext,
  RuntimeId,
  SandboxExec as PortSandboxExec,
  TerminalStartup,
} from './agent-runtime.port';
import {
  CLAUDE_AUTH_SOURCE,
  type ClaudeAuthSource,
} from '../sandbox/claude-auth-source.port';
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

/** Provision-time credential/config + prompt injection context (task 3.1). */
export interface InjectAuthContext {
  readonly taskId: string;
  readonly workspaceDir: string;
  /** The operator's task prompt, or null when the task has none. */
  readonly prompt: string | null;
}

/**
 * The turn-completion verdict the consumer poller maps. `done:false` → keep
 * polling; `done:null` → inconclusive (re-check); `done:true` → terminate (the
 * runtime has already killed the session), optionally carrying an explicit status.
 */
export type RuntimeExitDecision =
  | { readonly done: false }
  | { readonly done: null }
  | {
      readonly done: true;
      readonly status?: { code: number | null; abnormal: boolean };
    };

/**
 * The consumer-facing runtime surface (what the provider/PTY client were written
 * against). Each method adapts to a leaf {@link PortAgentRuntime} method.
 */
export interface AgentRuntime {
  readonly id: RuntimeId;
  buildLaunchLine(ctx: LaunchContext): string;
  /** Declarative terminal-startup policy the pty mechanism reads (delegates to the port). */
  readonly terminalStartup: TerminalStartup;
  injectAuth(exec: SandboxExec, ctx: InjectAuthContext): Promise<void>;
  detectExit(exec: SandboxExec, taskId: string): Promise<RuntimeExitDecision>;
  /** Optional pre-stop HOME trim; absent for codex (the provider keeps its inline trim). */
  trimBeforeStop?(exec: SandboxExec, taskId: string): Promise<void>;
}

/** The registry the consumers inject under {@link RUNTIME_REGISTRY}. */
export interface RuntimeRegistry {
  /** Resolve a runtime by id (codex by default; throws on an unknown id). */
  resolve(id?: RuntimeId | null): AgentRuntime;
  /** Resolve the runtime selected by the task's persisted `runtime` column. */
  resolveForTask(taskId: string): Promise<AgentRuntime>;
}

/** Adapt a consumer {@link SandboxExec} closure to the leaf {@link PortSandboxExec}. */
function toPortExec(exec: SandboxExec): PortSandboxExec {
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
function sessionIdForTask(taskId: string): string {
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
 * Wraps a leaf {@link PortAgentRuntime} in the consumer-facing {@link AgentRuntime}
 * shape. The adapter owns the leaf-port translation AND the claude-only
 * credential/prompt wiring the provider delegates (task 3.1): codex forwards
 * unchanged; claude resolves its OAuth token from {@link ClaudeAuthSource} and
 * injects the prompt file the launch line reads.
 */
class RuntimeAdapter implements AgentRuntime {
  private readonly logger = new Logger(`RuntimeAdapter:${this.runtime.id}`);

  constructor(
    private readonly runtime: PortAgentRuntime,
    private readonly claudeAuth: ClaudeAuthSource | undefined,
  ) {}

  get id(): RuntimeId {
    return this.runtime.id;
  }

  buildLaunchLine(ctx: LaunchContext): string {
    const portCtx: PortLaunchContext = {
      taskId: ctx.taskId,
      workspaceDir: ctx.workspaceDir,
      sessionId: sessionIdForTask(ctx.taskId),
    };
    return this.runtime.buildLaunchLine(portCtx);
  }

  get terminalStartup(): TerminalStartup {
    // Delegate to the port runtime's DECLARED policy — no agent-identity branch.
    return this.runtime.terminalStartup;
  }

  async injectAuth(exec: SandboxExec, ctx: InjectAuthContext): Promise<void> {
    const material = await this.resolveAuthMaterial();
    const result = await this.runtime.injectAuth(toPortExec(exec), material);
    if (result.ok === false) {
      // Fail-closed (claude with no token): a distinct reason the provision
      // try/catch maps to a torn-down container + failed task (agent-runtime spec).
      // Read `reason` off the narrowed false-branch via an index access so it does
      // not depend on strict discriminated-union narrowing being enabled.
      const reason = (result as { reason?: string }).reason ?? 'runtime not configured';
      throw new Error(reason);
    }
    // claude delegates the WHOLE provision-time setup to the runtime path (3.1):
    // the launch line reads the prompt via `$(cat <prompt-file>)`, so the prompt
    // file must be written here. codex's prompt is injected by the provider's own
    // inline `injectTaskPrompt`, so it is NOT re-injected here.
    if (this.runtime.id !== 'codex' && ctx.prompt) {
      await this.injectClaudePrompt(exec, ctx.prompt);
    }
  }

  async detectExit(exec: SandboxExec, taskId: string): Promise<RuntimeExitDecision> {
    const signal = await this.runtime.detectExit(toPortExec(exec), {
      taskId,
      workspaceDir: CLAUDE_WORKSPACE_DIR,
      sessionId: sessionIdForTask(taskId),
    });
    return signal.status === 'done' ? { done: true } : { done: false };
  }

  /**
   * Pre-stop HOME trim, claude only: drop `~/.claude` bulk while KEEPING
   * `projects/` (the session transcript) — the defense-in-depth analog of codex's
   * `~/.codex` trim. Absent on the codex adapter (see {@link buildAdapter}) so the
   * provider keeps its unchanged inline `trimCodexHomeBeforeStop`.
   */
  async trimBeforeStop(exec: SandboxExec, _taskId: string): Promise<void> {
    const dir = ClaudeCodeRuntime.CONFIG_DIR;
    await exec(
      `find ${dir} -mindepth 1 -maxdepth 1 ! -name projects -exec rm -rf {} + 2>/dev/null; true`,
    );
  }

  /** Resolve the leaf {@link AuthMaterial} for this runtime (claude: the OAuth token). */
  private async resolveAuthMaterial(): Promise<AuthMaterial | null> {
    if (this.runtime.id === 'codex') {
      // Codex auth is written by the provider's own inline `injectCodexAuth`; the
      // codex adapter's injectAuth is never reached on the provision path (the
      // provider only delegates for non-codex runtimes), but degrade safely.
      return null;
    }
    if (!this.claudeAuth) return null;
    const material = await this.claudeAuth.getClaudeAuth();
    return material ? { oauthToken: material.oauthToken } : null;
  }

  /** Write the operator prompt into the claude prompt file the launch line reads. */
  private async injectClaudePrompt(exec: SandboxExec, prompt: string): Promise<void> {
    const file = ClaudeCodeRuntime.PROMPT_FILE_PATH;
    const dir = ClaudeCodeRuntime.CONFIG_DIR;
    const b64 = Buffer.from(prompt, 'utf8').toString('base64');
    const { exitCode } = await exec(
      `mkdir -p ${dir} && printf %s '${b64}' | base64 -d > ${file} && chmod 600 ${file}`,
    );
    if (Number.isNaN(exitCode) || exitCode !== 0) {
      throw new Error(`claude prompt injection failed: exit_code ${exitCode}`);
    }
  }
}

/** The cloned-workspace dir the detached session runs in (shared by both paths). */
const CLAUDE_WORKSPACE_DIR = '/home/gem/workspace';

/**
 * Nest-injectable {@link RuntimeRegistry}: builds the leaf {@link AgentRuntimeRegistry}
 * from the two concrete runtimes, reads each task's persisted `runtime` value via
 * the {@link ProvisionLookup} port, and returns per-task {@link RuntimeAdapter}s.
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
    @Inject(CLAUDE_AUTH_SOURCE)
    private readonly claudeAuth?: ClaudeAuthSource,
    @Optional()
    @Inject(PROVISION_LOOKUP)
    private readonly lookup?: ProvisionLookup,
  ) {}

  resolve(id?: RuntimeId | null): AgentRuntime {
    return this.adapt(this.registry.resolve(id));
  }

  async resolveForTask(taskId: string): Promise<AgentRuntime> {
    const runtime = await this.readTaskRuntime(taskId);
    return this.adapt(this.registry.resolve(runtime));
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

  private adapt(runtime: PortAgentRuntime): AgentRuntime {
    return new RuntimeAdapter(runtime, this.claudeAuth);
  }
}
