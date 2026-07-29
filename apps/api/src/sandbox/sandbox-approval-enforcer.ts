import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  FRAME_CHANNEL,
  PermissionRequestFrameSchema,
  type Decision,
  type PermissionRequestFrame,
} from '@cap-console/contracts';

/**
 * Dormant cap-controlled approval-enforcement primitive.
 *
 * WHY THIS EXISTS:
 *   Bypass-mode Codex tasks deliberately do not register the historical
 *   `PreToolUse` hook, and the interactive provider PTY is not a CAP command
 *   broker. This class offers a fail-closed wrapper that a future, explicitly
 *   CAP-brokered action can call before executing.
 *
 * CURRENT COVERAGE:
 *   No production call site invokes `enforce` or `enforceThen`; DI registration
 *   alone is not enforcement. Ordinary setup `/v1/shell/exec` calls and agent
 *   commands inside `/v1/shell/ws` are therefore NOT covered by this class.
 *
 * If a future call site is added, it reuses the existing approval router and MUST
 * call `enforceThen` around the action; documentation/tests must not infer
 * coverage merely from the provider binding.
 */

/**
 * The minimal approval round-trip the enforcer depends on — satisfied by the
 * gateway's `requestApproval(frame) -> DecisionFrame`. Depending on this port
 * (not the concrete gateway) keeps the enforcer unit-testable and avoids a
 * provider->gateway hard import cycle.
 */
export interface ApprovalRouter {
  /**
   * Route a `permission_request` through the existing operator approval path and
   * resolve with the operator's decision. SHALL NOT resolve until a decision is
   * available (or the caller's timeout fires).
   */
  requestApproval(frame: PermissionRequestFrame): Promise<{ decision: Decision }>;
}

/** A tool-affecting action the enforcer gates before it runs in the sandbox. */
export interface GatedToolCall {
  /** The task whose sandbox the command targets (frame `taskId`; must be a uuid). */
  readonly taskId: string;
  /** The gated tool name (e.g. `shell`, `apply_patch`). */
  readonly toolName: string;
  /** Opaque tool input forwarded to the operator for review (e.g. the command). */
  readonly toolInput: unknown;
}

/** The outcome of an enforced gate: whether the action may proceed, and why. */
export interface EnforcementOutcome {
  /** True ONLY when an operator returned an explicit `allow`. */
  readonly allowed: boolean;
  /** The operator's message, when present. */
  readonly reason?: string;
}

/**
 * Default upper bound on how long the enforcer waits for an operator decision
 * before failing CLOSED. A non-decision is a DENY here: an explicitly gated
 * action must never proceed without an explicit allow.
 */
const DEFAULT_DECISION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Fail-closed approval primitive for a future explicitly gated CAP-owned action.
 */
export class SandboxApprovalEnforcer {
  private readonly logger = new Logger(SandboxApprovalEnforcer.name);

  constructor(
    private readonly approvals: ApprovalRouter,
    private readonly decisionTimeoutMs: number = DEFAULT_DECISION_TIMEOUT_MS,
  ) {}

  /**
   * Gate a tool-affecting action: route a `permission_request` through the
   * existing approval path and resolve with whether it may proceed. Fails CLOSED
   * (allowed=false) on `deny`, on an approval error, or on decision timeout —
   * the action never runs without an explicit `allow`.
   */
  async enforce(call: GatedToolCall): Promise<EnforcementOutcome> {
    const frame = this.buildFrame(call);

    let decision: Decision;
    try {
      const result = await this.withTimeout(this.approvals.requestApproval(frame));
      decision = result.decision;
    } catch (err) {
      // No decision (timeout) or an approval-path error: fail CLOSED. The gated
      // tool call must NOT proceed without an explicit operator allow.
      this.logger.warn(
        `task ${call.taskId}: approval round-trip did not yield an allow (${(err as Error).message}); denying gated ${call.toolName}`,
      );
      return { allowed: false, reason: 'no approval decision (fail closed)' };
    }

    if (decision.behavior === 'allow') {
      return { allowed: true, reason: decision.message };
    }
    // Explicit deny (or any non-allow behavior): do not proceed.
    return { allowed: false, reason: decision.message ?? 'denied by operator' };
  }

  /**
   * Gate THEN run: only invokes `run` when the enforced decision is `allow`. When
   * denied, `run` is NEVER called and the method throws so the caller cannot
   * accidentally proceed. This is the safe wrapper provider/exec call sites use
   * around a cap-owned `/v1/shell/exec` tool-affecting command.
   */
  async enforceThen<T>(call: GatedToolCall, run: () => Promise<T>): Promise<T> {
    const outcome = await this.enforce(call);
    if (!outcome.allowed) {
      throw new ApprovalDeniedError(call.toolName, outcome.reason);
    }
    return run();
  }

  /** Build a schema-valid `permission_request` frame for the gated call. */
  private buildFrame(call: GatedToolCall): PermissionRequestFrame {
    return PermissionRequestFrameSchema.parse({
      channel: FRAME_CHANNEL.CONTROL,
      type: 'permission_request',
      requestId: randomUUID(),
      taskId: call.taskId,
      toolName: call.toolName,
      toolInput: call.toolInput ?? null,
    });
  }

  /** Reject after `decisionTimeoutMs` so a never-answered request fails closed. */
  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`approval decision timed out after ${this.decisionTimeoutMs}ms`)),
        this.decisionTimeoutMs,
      );
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }
}

/** Thrown by {@link SandboxApprovalEnforcer.enforceThen} when the gate denies the call. */
export class ApprovalDeniedError extends Error {
  constructor(toolName: string, reason?: string) {
    super(`gated tool call '${toolName}' denied by cap-controlled approval enforcer${reason ? `: ${reason}` : ''}`);
    this.name = 'ApprovalDeniedError';
  }
}
