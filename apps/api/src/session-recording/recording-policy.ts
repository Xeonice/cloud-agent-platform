/**
 * Capacity policy for optional raw terminal artifacts.
 *
 * Native live-terminal fidelity does not depend on `session.log` or
 * `session.cast`. Both artifacts are therefore explicit diagnostics opt-ins,
 * with one shared write/read budget for the cast so a file produced by the
 * gateway can never exceed the controller's accepted size.
 */

export const DEFAULT_TERMINAL_RAW_ARTIFACT_MAX_BYTES = 24 * 1024 * 1024;
export const MAX_TERMINAL_RAW_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const MIN_TERMINAL_RAW_ARTIFACT_MAX_BYTES = 1024;

export const DEFAULT_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES = 8 * 1024;
export const MAX_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES = 64 * 1024;
export const MIN_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES = 1024;

export const DEFAULT_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES = 512;
export const MAX_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES = 4096;
export const MIN_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES = 8;

export const TERMINAL_RAW_RECORDING_TRUNCATION_TEXT =
  '\r\n[CAP raw terminal recording truncated at the configured byte budget]\r\n';

export interface TerminalRawArtifactPolicy {
  readonly enabled: boolean;
  readonly maxBytes: number;
}

export interface TerminalRecordingPolicy {
  readonly sessionLog: TerminalRawArtifactPolicy;
  readonly sessionCast: TerminalRawArtifactPolicy;
  readonly failureEvidenceMaxBytes: number;
  readonly maxPendingWrites: number;
}

/**
 * Parse a deployment policy. Invalid opt-in or budget values fail startup;
 * silently accepting a typo could re-enable unbounded multi-gigabyte files.
 */
export function readTerminalRecordingPolicy(
  env: NodeJS.ProcessEnv = process.env,
): TerminalRecordingPolicy {
  return Object.freeze({
    sessionLog: Object.freeze({
      enabled: readExplicitOptIn(
        env,
        'CAP_TERMINAL_RAW_LOG_RECORDING_ENABLED',
      ),
      maxBytes: readBoundedInteger(
        env,
        'CAP_TERMINAL_RAW_LOG_MAX_BYTES',
        DEFAULT_TERMINAL_RAW_ARTIFACT_MAX_BYTES,
        MIN_TERMINAL_RAW_ARTIFACT_MAX_BYTES,
        MAX_TERMINAL_RAW_ARTIFACT_MAX_BYTES,
      ),
    }),
    sessionCast: Object.freeze({
      enabled: readExplicitOptIn(
        env,
        'CAP_TERMINAL_RAW_CAST_RECORDING_ENABLED',
      ),
      maxBytes: readBoundedInteger(
        env,
        'CAP_TERMINAL_RAW_CAST_MAX_BYTES',
        DEFAULT_TERMINAL_RAW_ARTIFACT_MAX_BYTES,
        MIN_TERMINAL_RAW_ARTIFACT_MAX_BYTES,
        MAX_TERMINAL_RAW_ARTIFACT_MAX_BYTES,
      ),
    }),
    failureEvidenceMaxBytes: readBoundedInteger(
      env,
      'CAP_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES',
      DEFAULT_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES,
      MIN_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES,
      MAX_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES,
    ),
    maxPendingWrites: readBoundedInteger(
      env,
      'CAP_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES',
      DEFAULT_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES,
      MIN_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES,
      MAX_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES,
    ),
  });
}

function readExplicitOptIn(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === '0' || raw === 'false') {
    return false;
  }
  if (raw === '1' || raw === 'true') return true;
  throw new RangeError(`${name} must be one of true, false, 1, or 0`);
}

function readBoundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
