import { ServiceUnavailableException } from '@nestjs/common';
import {
  TaskProvisioningDiagnosticsUnavailableErrorSchema,
  type Scope,
} from '@cap/contracts';

const UNAVAILABLE_ERROR =
  TaskProvisioningDiagnosticsUnavailableErrorSchema.parse({
    code: 'task_provisioning_diagnostics_unavailable',
    message: 'Task provisioning diagnostics are temporarily unavailable.',
    retryable: true,
  });

/**
 * One deployment-wide compatibility decision shared by diagnostic reads and
 * credential grants. The production binding is the full API/MCP/Web evaluator
 * and remains default-closed until every role reports its actual capabilities;
 * this port deliberately has no independent read/grant switch.
 */
export const TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE =
  'TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE';

export interface TaskProvisioningDiagnosticsCapabilityGatePort {
  /** Fail before any diagnostic read when deployment compatibility is absent. */
  assertReadOpen(): void;
  /** Fail before minting when the requested scopes need the same capability. */
  assertScopesGrantable(scopes: readonly Scope[]): void;
}

/** Fail-closed fallback for isolated construction and missing DI bindings. */
export const CLOSED_TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE:
  TaskProvisioningDiagnosticsCapabilityGatePort = Object.freeze({
    assertReadOpen: rejectReadUnavailable,
    assertScopesGrantable: (scopes: readonly Scope[]) => {
      if (scopes.includes('tasks:diagnostics')) rejectGrantUnavailable();
    },
  });

/**
 * Canonical credential-grant boundary. It deliberately does not consult the
 * capability gate for an ordinary scope set, so even an unavailable attestation
 * cannot regress existing API-key/MCP-token minting. A diagnostics grant must
 * pass the same gate object used by the read surface.
 */
export function assertTaskProvisioningDiagnosticsScopeGrantable(
  scopes: readonly Scope[],
  gate: TaskProvisioningDiagnosticsCapabilityGatePort,
): void {
  if (!scopes.includes('tasks:diagnostics')) return;
  try {
    gate.assertScopesGrantable(scopes);
  } catch {
    // Capability evaluators are deployment inputs. Never expose their raw
    // exception/message through credential management.
    rejectGrantUnavailable();
  }
}

/** Canonical bounded read entrypoint shared by REST and the staged MCP adapter. */
export function assertTaskProvisioningDiagnosticsReadOpen(
  gate: TaskProvisioningDiagnosticsCapabilityGatePort,
): void {
  try {
    gate.assertReadOpen();
  } catch {
    // Fail closed with one safe transport error even if attestation evaluation
    // throws a non-conforming provider/configuration exception.
    rejectReadUnavailable();
  }
}

function rejectReadUnavailable(): never {
  throw new ServiceUnavailableException(UNAVAILABLE_ERROR);
}

function rejectGrantUnavailable(): never {
  throw new ServiceUnavailableException(UNAVAILABLE_ERROR);
}
