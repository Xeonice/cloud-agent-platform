#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FRAME_CHANNEL } from '@cap/contracts';
import {
  Decision,
  DecisionEnvelope,
  DecisionSchema,
  PermissionRequestFrame,
  PermissionRequestFrameSchema,
  parseDecision,
} from './contract.js';
import { resolveDecisions } from './resolve-decision.js';

/**
 * Blocking Codex `PermissionRequest`/`PreToolUse` hook (agent-events-and-approvals
 * spec, "Blocking hook forwards the approval round-trip").
 *
 * Codex invokes this hook for a tool call. The hook:
 *   1. forwards the event to the orchestrator,
 *   2. blocks until a decision (or set of contributing decisions) returns,
 *   3. resolves multiple decisions with any-deny-wins,
 *   4. validates that `behavior` is within `allow`/`deny` (rejecting anything
 *      else BEFORE emitting), and
 *   5. prints the `{ decision }` JSON to stdout for Codex to consume.
 *
 * The hook is NOT the security boundary — sandbox isolation + ephemeral creds are
 * (design D6). It exists purely for human-in-the-loop approval.
 */

/**
 * Transport the hook uses to round-trip the approval with the orchestrator. Under
 * the connect-in topology (migrate-execution-to-aio-sandbox) the concrete
 * transport is the OUTBOUND HTTP callback {@link HttpApprovalTransport} below: the
 * sandbox POSTs the `permission_request` frame to the orchestrator approvals
 * endpoint, reachable by container name over the private `cap-net` network
 * (replacing the prior runner dial-back / WebSocket transport). The hook depends
 * only on this minimal port so the approval routing above it is unchanged and it
 * can be driven and tested in isolation.
 */
export interface ApprovalTransport {
  /**
   * Forward a `PermissionRequest` frame to the orchestrator and resolve with the
   * operator's contributing decision(s). The promise SHALL NOT resolve until a
   * decision is available, so the hook blocks the tool call until the operator
   * responds.
   */
  requestDecision(event: PermissionRequestFrame): Promise<unknown>;
}

/**
 * Outbound HTTP approval transport (migrate-execution-to-aio-sandbox, Track
 * derived-image-and-hooks, task 5.4).
 *
 * Re-homes the approval round-trip onto a single outbound HTTP POST from the
 * sandbox to the orchestrator's approvals endpoint. Because the sandbox has no
 * inbound host port, network isolation on `cap-net` is the boundary; the
 * orchestrator is addressed by container name (e.g.
 * `http://<orchestrator>:<port>/v1/approvals`). This implements the EXISTING
 * {@link ApprovalTransport} contract verbatim, so ONLY the transport layer
 * changes — `runPermissionRequestHook`'s forwarding/any-deny-wins/fail-closed
 * routing above it is untouched.
 *
 * The endpoint is expected to respond with the orchestrator's decision JSON: a
 * single `{behavior,message?}` decision, a list of contributing decisions, or a
 * `{decision}` envelope. Any other shape (including a non-2xx response or a
 * network error) resolves to `null`, which the hook treats as a fail-closed
 * deny — the blocked tool call never proceeds without an explicit `allow`.
 */
export class HttpApprovalTransport implements ApprovalTransport {
  constructor(
    /** Absolute orchestrator approvals URL, reachable by container name on `cap-net`. */
    private readonly approvalsUrl: string,
    /** Injectable fetch (defaults to the global) so the transport is testable. */
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async requestDecision(event: PermissionRequestFrame): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.approvalsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
    } catch {
      // Network failure reaching the orchestrator over cap-net: surface an
      // unparseable response so the hook fails closed (deny).
      return null;
    }

    if (!response.ok) {
      return null;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }

    // Accept either a bare decision/array or a `{decision}` envelope; unwrap the
    // envelope so the existing decision-resolution logic sees the decision(s).
    if (
      body !== null &&
      typeof body === 'object' &&
      'decision' in (body as Record<string, unknown>)
    ) {
      return (body as { decision: unknown }).decision;
    }
    return body;
  }
}

/**
 * Orchestrator decision responses may arrive as a single decision or as a list
 * of contributing decisions (multiple matching policies/operators). Either shape
 * is accepted; each entry is validated against the decision schema and any entry
 * with an out-of-range `behavior` causes a fail-closed `deny` rather than an
 * emitted invalid decision.
 */
const DecisionResponseSchema = z.union([
  DecisionSchema,
  z.array(z.unknown()),
]);

/**
 * Normalise an orchestrator response into the set of contributing decisions,
 * rejecting (dropping) any malformed entry. Returns `null` only when the
 * response shape itself is unparseable.
 */
function toContributingDecisions(response: unknown): Decision[] | null {
  const parsed = DecisionResponseSchema.safeParse(response);
  if (!parsed.success) {
    return null;
  }

  if (Array.isArray(parsed.data)) {
    const decisions: Decision[] = [];
    for (const candidate of parsed.data) {
      const decision = parseDecision(candidate);
      if (decision === null) {
        // A contributing decision with a behavior outside allow/deny is
        // malformed. Per the spec, a malformed decision is never emitted; we
        // treat it as a fail-closed deny contribution.
        return [{ behavior: 'deny', message: 'rejected malformed contributing decision' }];
      }
      decisions.push(decision);
    }
    return decisions;
  }

  return [parsed.data];
}

/**
 * Run the blocking hook for one permission request. Returns the `{ decision }`
 * envelope that should be printed to Codex. Always returns a valid envelope
 * (fail-closed deny when anything is wrong), so the caller never emits an
 * invalid decision to Codex.
 */
export async function runPermissionRequestHook(
  event: PermissionRequestFrame,
  transport: ApprovalTransport,
): Promise<DecisionEnvelope> {
  // Block until the orchestrator returns the operator's decision(s).
  const response = await transport.requestDecision(event);

  const contributing = toContributingDecisions(response);
  if (contributing === null) {
    // Unparseable response: never emit an invalid decision — fail closed.
    return { decision: { behavior: 'deny', message: 'no valid decision returned' } };
  }

  const resolved = resolveDecisions(contributing);

  // Final guard: re-validate the resolved decision before emitting. This is the
  // last point at which an out-of-range behavior is rejected.
  const validated = parseDecision(resolved);
  if (validated === null) {
    return { decision: { behavior: 'deny', message: 'resolved decision failed validation' } };
  }

  return { decision: validated };
}

// ---------------------------------------------------------------------------
// codex 0.131 hook protocol adapter (harden-aio-execution, Track
// hooks-0131-adapter, task 5.2)
// ---------------------------------------------------------------------------

/**
 * The codex `0.131` `PreToolUse` stdin payload (Claude-Code-style hooks). Only
 * `tool_name`/`tool_input` are load-bearing for the round-trip; the remaining
 * fields are identity/context codex provides. Everything is optional/loose so a
 * minor codex payload drift does not fail-open: an unparseable payload still
 * fails closed, but a present-but-extra field never rejects a real request.
 */
export const Codex0131StdinSchema = z.object({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
  model: z.string().optional(),
  permission_mode: z.string().optional(),
  turn_id: z.string().optional(),
  tool_name: z.string().min(1),
  tool_use_id: z.string().optional(),
  tool_input: z.unknown().optional(),
});
export type Codex0131Stdin = z.infer<typeof Codex0131StdinSchema>;

/** The default `hookEventName` echoed back when codex does not send one. */
const DEFAULT_HOOK_EVENT_NAME = 'PreToolUse';

/** A zeroed uuid used when no cap `TASK_ID` is injected (frame still validates). */
const NIL_TASK_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The codex `0.131` JSON decision form emitted on stdout. `permissionDecision`
 * is constrained to `allow`/`deny`; `permissionDecisionReason` carries the
 * operator's message. Codex reads this from stdout (the alternative is exit
 * `0`=allow / exit `2`+stderr=deny — see {@link emitCodex0131Decision}).
 */
export interface Codex0131Decision {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

/**
 * Translate a codex `0.131` stdin payload into cap's existing
 * `permission_request` frame so the EXISTING `POST /v1/approvals` round-trip and
 * any-deny-wins/fail-closed routing above the transport are unchanged.
 *
 * Field mapping (codex 0.131 -> cap frame):
 *   - `tool_name`   -> `toolName`
 *   - `tool_input`  -> `toolInput` (opaque, forwarded verbatim for review)
 *   - `tool_use_id`/`turn_id`/`session_id` -> `requestId` (per-call correlation;
 *     a fresh uuid is generated when codex sends none)
 *   - cap `taskId` is not carried by codex 0.131; it is sourced from the
 *     `TASK_ID` env injected into the sandbox (nil-uuid fallback keeps the frame
 *     schema-valid so the request still forwards rather than failing open).
 */
export function codex0131ToPermissionRequestFrame(
  payload: Codex0131Stdin,
  taskId: string,
): PermissionRequestFrame {
  const requestId =
    payload.tool_use_id ?? payload.turn_id ?? payload.session_id ?? randomUUID();
  const candidateTaskId = taskId.length > 0 ? taskId : NIL_TASK_ID;
  return PermissionRequestFrameSchema.parse({
    channel: FRAME_CHANNEL.CONTROL,
    type: 'permission_request',
    requestId,
    taskId: candidateTaskId,
    toolName: payload.tool_name,
    toolInput: payload.tool_input ?? null,
  });
}

/**
 * Render a resolved cap {@link Decision} into the codex `0.131` JSON decision
 * form. `hookEventName` echoes codex's event (default `PreToolUse`); the
 * decision message becomes `permissionDecisionReason`.
 */
export function toCodex0131Decision(
  decision: Decision,
  hookEventName: string = DEFAULT_HOOK_EVENT_NAME,
): Codex0131Decision {
  return {
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: decision.behavior,
      ...(decision.message !== undefined
        ? { permissionDecisionReason: decision.message }
        : {}),
    },
  };
}

/**
 * Emit a resolved decision in BOTH codex `0.131` channels: the JSON
 * `{hookSpecificOutput:{permissionDecision}}` on stdout AND the exit-code
 * convention (exit `0` = allow, exit `2` + stderr reason = deny). Codex accepts
 * either; emitting both is unambiguous. Returns the chosen exit code so the CLI
 * can set `process.exitCode` (kept as a return value rather than a side effect
 * so it is unit-testable).
 */
export function emitCodex0131Decision(
  decision: Decision,
  hookEventName: string,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): 0 | 2 {
  const json = toCodex0131Decision(decision, hookEventName);
  stdout.write(JSON.stringify(json));
  if (decision.behavior === 'deny') {
    // Exit-code deny channel: codex reads a non-zero exit + stderr as a block.
    stderr.write(decision.message ?? 'denied by approval policy');
    return 2;
  }
  return 0;
}

/**
 * Read the codex `0.131` hook payload from stdin, translate it to cap's
 * `permission_request` frame, run the blocking round-trip, and emit the codex
 * `0.131` decision form (JSON on stdout + exit-code convention).
 *
 * `transport` is injected so callers can wire the concrete transport; under
 * connect-in the CLI bootstrap below wires {@link HttpApprovalTransport} from
 * `ORCHESTRATOR_APPROVALS_URL`, while tests supply a stub. Returns the exit code
 * the CLI should set (`0` allow / `2` deny).
 */
export async function main(
  transport: ApprovalTransport,
  taskId: string = process.env['TASK_ID'] ?? '',
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<0 | 2> {
  const raw = await readAll(stdin);

  let payload: Codex0131Stdin;
  try {
    payload = Codex0131StdinSchema.parse(JSON.parse(raw));
  } catch {
    // A payload we cannot parse as a codex 0.131 hook event is forwarded
    // nowhere; fail closed so codex never proceeds on a malformed request.
    return emitCodex0131Decision(
      { behavior: 'deny', message: 'unparseable codex 0.131 hook payload' },
      DEFAULT_HOOK_EVENT_NAME,
      stdout,
      stderr,
    );
  }

  const hookEventName = payload.hook_event_name ?? DEFAULT_HOOK_EVENT_NAME;
  const frame = codex0131ToPermissionRequestFrame(payload, taskId);
  const envelope = await runPermissionRequestHook(frame, transport);
  return emitCodex0131Decision(envelope.decision, hookEventName, stdout, stderr);
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * CLI bootstrap (migrate-execution-to-aio-sandbox, Track derived-image-and-hooks,
 * task 5.4). This file is baked into the derived AIO image at
 * `/opt/cap/dist/hooks/permission-request.hook.js` and invoked by Codex as a
 * blocking `PreToolUse`/`PermissionRequest` hook (see `~/.codex/hooks.json`).
 *
 * When run directly, it self-wires the {@link HttpApprovalTransport} from the
 * `ORCHESTRATOR_APPROVALS_URL` env injected into the sandbox container by
 * `AioSandboxProvider`, then runs the blocking round-trip over stdin/stdout. If
 * the env is absent the hook fails closed (deny) rather than letting the tool
 * call proceed unapproved.
 */
export async function runCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const approvalsUrl = env['ORCHESTRATOR_APPROVALS_URL'];
  if (approvalsUrl === undefined || approvalsUrl.length === 0) {
    // No transport configured: never proceed unapproved — emit a fail-closed
    // deny (codex 0.131 form + exit 2) so Codex blocks the tool call.
    process.exitCode = emitCodex0131Decision(
      { behavior: 'deny', message: 'ORCHESTRATOR_APPROVALS_URL is not configured' },
      DEFAULT_HOOK_EVENT_NAME,
      process.stdout,
      process.stderr,
    );
    return;
  }
  process.exitCode = await main(
    new HttpApprovalTransport(approvalsUrl),
    env['TASK_ID'] ?? '',
  );
}

// Run only when executed as the entry module (the baked hook script), never on
// import (tests import `runPermissionRequestHook`/`main` with a stub transport).
// realpath both sides so a symlinked entry path still matches import.meta.url.
const entry = process.argv[1];
if (entry !== undefined) {
  let isEntry = false;
  try {
    isEntry = fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    isEntry = false;
  }
  if (isEntry) {
    void runCli();
  }
}
