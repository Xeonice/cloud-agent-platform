import type { RuntimeId } from './agent-runtime.port';

export type RuntimeModelRejectionEvidenceSource =
  | 'codex-app-server-error'
  | 'claude-stream-json-result';

/**
 * Allowlisted structured fields only. Raw message/stderr/provider bodies are
 * deliberately absent so this value can never turn presentation text into a
 * stable task-failure classification.
 */
export interface RuntimeModelRejectionEvidence {
  readonly runtime: RuntimeId;
  readonly cliVersion: string;
  readonly source: RuntimeModelRejectionEvidenceSource;
  readonly stableCode: string;
}

export interface RuntimeModelRejectionEvidenceEntry
  extends RuntimeModelRejectionEvidence {
  readonly provenance: string;
  readonly evidenceChecksum: `sha256:${string}`;
}

export interface RuntimeModelRejectionEvidencePolicy {
  readonly cliPins: Readonly<Record<RuntimeId, string>>;
  readonly entries: readonly RuntimeModelRejectionEvidenceEntry[];
}

/**
 * The pinned CLIs currently expose no dedicated, verified model-rejection code:
 * Codex App Server 0.144.1 reports only generic `badRequest`, while Claude Code
 * 2.1.207 evidence has not yet proved a dedicated stream-json rejection code.
 * An empty list is intentional fail-closed policy, not missing fallback logic.
 */
export const CHECKED_RUNTIME_MODEL_REJECTION_EVIDENCE_POLICY = {
  cliPins: {
    codex: '0.144.1',
    'claude-code': '2.1.207',
  },
  entries: [],
} as const satisfies RuntimeModelRejectionEvidencePolicy;

/** Return the stable failure only for an exact, pin-bound evidence entry. */
export function classifyRuntimeModelRejectionEvidence(
  evidence: RuntimeModelRejectionEvidence,
  policy: RuntimeModelRejectionEvidencePolicy =
    CHECKED_RUNTIME_MODEL_REJECTION_EVIDENCE_POLICY,
): 'runtime_model_rejected' | null {
  if (policy.cliPins[evidence.runtime] !== evidence.cliVersion) return null;
  return policy.entries.some(
    (entry) =>
      entry.runtime === evidence.runtime &&
      entry.cliVersion === evidence.cliVersion &&
      entry.source === evidence.source &&
      entry.stableCode === evidence.stableCode &&
      /^sha256:[a-f0-9]{64}$/u.test(entry.evidenceChecksum) &&
      /^https:\/\//u.test(entry.provenance),
  )
    ? 'runtime_model_rejected'
    : null;
}
