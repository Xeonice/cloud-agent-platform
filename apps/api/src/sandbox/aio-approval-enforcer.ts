import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  FRAME_CHANNEL,
  PermissionRequestFrameSchema,
  type Decision,
  type PermissionRequestFrame,
} from '@cap/contracts';

/**
 * Cap-controlled approval enforcement FALLBACK (harden-aio-execution, integration
 * task 6.9; design D8 ★, codex#16732).
 *
 * WHY THIS EXISTS:
 *   The codex `0.131` `PreToolUse` hook is the PRIMARY approval path, but it has
 *   been observed to silently NOT fire even with the correct 0.131 format,
 *   `--full-auto`, hook trust, and matcher `.*` (codex#16732 — 0.131 is a
 *   research preview). If approval depended SOLELY on codex firing the hook, a
 *   non-firing hook would fail OPEN: a gated tool call would execute with no
 *   operator decision. That is unacceptable for an approval gate.
 *
 *   This enforcer moves the gate to a layer CAP CONTROLS: the
 *   orchestrator–sandbox `/v1/shell/exec` boundary. cap owns this surface (it is
 *   how the orchestrator runs commands inside the per-task sandbox over
 *   `cap-net`), so cap — not codex — decides whether a tool-affecting command
 *   runs. Before executing a gated command in the sandbox, the orchestrator
 *   routes a `permission_request` through the EXISTING approval round-trip
 *   (`requestApproval` -> `onPermissionRequest` fan-out -> operator `onDecision`)
 *   and proceeds ONLY on an explicit `allow`. On `deny`, on an approval error, or
 *   on no decision, the command DOES NOT RUN (fail closed).
 *
 * TOOL-SURFACE COVERAGE (and gaps), documented per the task:
 *   - COVERED: every command the orchestrator itself issues into the sandbox via
 *     `/v1/shell/exec` (the cap-owned exec boundary) — e.g. provider-initiated or
 *     orchestrator-mediated shell tool calls. cap mediates these, so the gate is
 *     authoritative for them regardless of codex hook firing.
 *   - GAP: commands codex runs DIRECTLY inside the interactive `/v1/shell/ws` TUI
 *     session (not through cap's `/v1/shell/exec`) are NOT individually mediated
 *     by this enforcer — there cap is a byte pipe, not a command broker. For that
 *     surface the codex hook remains the in-band gate; the network boundary
 *     (`cap-net`, no host port) plus ephemeral per-task creds remain the
 *     containment boundary, and the post-tool-use report still records activity.
 *     Closing this gap (e.g. mediating the interactive channel command-by-command)
 *     is the documented follow-up; this enforcer guarantees the cap-owned
 *     `/v1/shell/exec` surface never fails open on a non-firing codex hook.
 *
 * The enforcer reuses the SAME approval routing as the codex-hook path — only the
 * TRIGGER differs (cap-initiated at the exec boundary vs. codex-hook-initiated),
 * so an operator sees and decides these requests through the same surface.
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
 * before failing CLOSED. A non-decision is a DENY here (the action must never
 * proceed without an explicit allow), matching the codex-hook fail-closed rule.
 */
const DEFAULT_DECISION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Enforces operator approval at the cap-owned `/v1/shell/exec` boundary, so a
 * gated tool call never proceeds on a non-firing codex hook (fail closed).
 */
export class AioApprovalEnforcer {
  private readonly logger = new Logger(AioApprovalEnforcer.name);

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

/** Thrown by {@link AioApprovalEnforcer.enforceThen} when the gate denies the call. */
export class ApprovalDeniedError extends Error {
  constructor(toolName: string, reason?: string) {
    super(`gated tool call '${toolName}' denied by cap-controlled approval enforcer${reason ? `: ${reason}` : ''}`);
    this.name = 'ApprovalDeniedError';
  }
}
