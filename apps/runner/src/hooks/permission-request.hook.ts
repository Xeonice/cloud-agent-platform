#!/usr/bin/env node
import { z } from 'zod';
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
 * Transport the hook uses to round-trip the approval with the orchestrator. The
 * concrete WebSocket/REST transport is supplied by the runner dial-back layer
 * (separate track); the hook depends only on this minimal port so it can be
 * driven and tested in isolation.
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

/**
 * Read the raw hook payload from stdin (the way Codex delivers hook input),
 * parse it as a `PermissionRequest` frame, run the blocking round-trip, and
 * print the `{ decision }` JSON to stdout for Codex.
 *
 * `transport` is injected so the runner can wire its dial-back connection; tests
 * supply a stub.
 */
export async function main(
  transport: ApprovalTransport,
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const raw = await readAll(stdin);

  let event: PermissionRequestFrame;
  try {
    event = PermissionRequestFrameSchema.parse(JSON.parse(raw));
  } catch {
    // A payload we cannot even parse as a permission_request frame is forwarded
    // nowhere; fail closed so Codex never proceeds on a malformed request.
    const denied: DecisionEnvelope = {
      decision: { behavior: 'deny', message: 'unparseable PermissionRequest payload' },
    };
    stdout.write(JSON.stringify(denied));
    return;
  }

  const envelope = await runPermissionRequestHook(event, transport);
  stdout.write(JSON.stringify(envelope));
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
