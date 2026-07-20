import { SandboxProviderConfigurationError } from './errors.js';

/**
 * Detached sandbox jobs (spec: sandbox-detached-jobs).
 *
 * A detached job is launched in its own session via `setsid` (never bare
 * `nohup`) so it survives teardown of the short-lived exec shell / HTTP
 * connection that spawned it. A wrapper process runs the job child in the
 * foreground, waits on it (reaping it regardless of whether the image's PID 1
 * reaps orphans), optionally performs an atomic workspace publish, and only
 * then writes the exit marker. Success or failure is ONLY ever concluded from
 * the exit marker contents — never inferred from progress-file silence,
 * progress-file contents, or the absence of the process.
 *
 * Both providers (BoxLite, AIO) consume this single implementation through the
 * shared stage-executor seam; provider packages must not reimplement detach
 * mechanics.
 */

/** Root directory of every per-job marker directory inside the sandbox. */
export const SANDBOX_DETACHED_JOBS_ROOT = '/tmp/cap-jobs';

export const SANDBOX_DETACHED_JOB_MARKER_FILES = [
  'pid',
  'progress',
  'exit',
] as const;
export type SandboxDetachedJobMarkerFile =
  (typeof SANDBOX_DETACHED_JOB_MARKER_FILES)[number];

const SANDBOX_DETACHED_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SandboxDetachedJobMarkerPaths {
  readonly dir: string;
  readonly pid: string;
  readonly progress: string;
  readonly exit: string;
}

export function validateSandboxDetachedJobId(jobId: string): string {
  if (!SANDBOX_DETACHED_JOB_ID_PATTERN.test(jobId)) {
    throw new SandboxProviderConfigurationError(
      'Sandbox detached job id must be 1-128 chars of [A-Za-z0-9._-] starting alphanumeric',
    );
  }
  return jobId;
}

/**
 * Per-job marker layout. `root` is overridable for tests only; production
 * callers use the default `/tmp/cap-jobs` root.
 */
export function sandboxDetachedJobMarkerPaths(
  jobId: string,
  root: string = SANDBOX_DETACHED_JOBS_ROOT,
): SandboxDetachedJobMarkerPaths {
  const id = validateSandboxDetachedJobId(jobId);
  const dir = `${validateAbsolutePath(root, 'marker root')}/${id}`;
  return Object.freeze({
    dir,
    pid: `${dir}/pid`,
    progress: `${dir}/progress`,
    exit: `${dir}/exit`,
  });
}

/** Atomic workspace publish executed by the wrapper only on child success. */
export interface SandboxDetachedJobPublishPlan {
  /** Absolute staging path the child materializes into. */
  readonly stagingPath: string;
  /** Absolute final path receiving one atomic rename as the last wrapper step. */
  readonly finalPath: string;
}

export interface SandboxDetachedJobLaunchPlan {
  readonly jobId: string;
  /** Shell command the wrapper runs and waits on as its foreground child. */
  readonly command: string;
  /** Optional absolute working directory for the child command. */
  readonly cwd?: string;
  /**
   * Workspace-producing jobs publish atomically: the tree becomes visible at
   * `finalPath` only through a single rename performed before the exit marker,
   * so a half-written tree can never be triaged as success.
   */
  readonly publish?: SandboxDetachedJobPublishPlan;
  /** Test-only marker root override; defaults to {@link SANDBOX_DETACHED_JOBS_ROOT}. */
  readonly markerRoot?: string;
}

/**
 * Build the launch exec command. Contract:
 *
 * - the job runs in its own session (`setsid`) and is double-forked, so it
 *   survives teardown of the launching shell and its HTTP connection;
 * - the wrapper's first act is writing its own pid to the `pid` marker
 *   (tmp+rename), and the launch command waits until the pid marker is
 *   readable before returning, so a caller that loses the launch response can
 *   still find the job;
 * - the child's stdout+stderr stream is redirected (append) into the
 *   `progress` marker;
 * - the wrapper waits on the child, then (on success) performs the atomic
 *   publish, then writes the child's numeric exit code to the `exit` marker
 *   exactly once via tmp+rename.
 */
export function buildSandboxDetachedJobLaunchCommand(
  plan: SandboxDetachedJobLaunchPlan,
): string {
  const paths = sandboxDetachedJobMarkerPaths(plan.jobId, plan.markerRoot);
  if (plan.command.trim().length === 0) {
    throw new SandboxProviderConfigurationError(
      'Sandbox detached job command must be non-empty',
    );
  }
  if (plan.cwd !== undefined) validateAbsolutePath(plan.cwd, 'cwd');
  if (plan.publish !== undefined) {
    validateAbsolutePath(plan.publish.stagingPath, 'publish stagingPath');
    validateAbsolutePath(plan.publish.finalPath, 'publish finalPath');
    if (plan.publish.stagingPath === plan.publish.finalPath) {
      throw new SandboxProviderConfigurationError(
        'Sandbox detached job publish stagingPath and finalPath must differ',
      );
    }
  }

  const child =
    plan.cwd === undefined
      ? plan.command
      : `cd ${shellQuote(plan.cwd)} && { ${plan.command}\n}`;

  const wrapperLines = [
    // Wrapper identity first: readable before the launch exec returns.
    `printf '%s' "$$" > ${shellQuote(`${paths.pid}.tmp`)} && mv -f ${shellQuote(`${paths.pid}.tmp`)} ${shellQuote(paths.pid)}`,
    // Run the child in the foreground: the wrapper waits on (and reaps) it.
    `( ${child}\n) </dev/null >> ${shellQuote(paths.progress)} 2>&1`,
    `cap_job_exit=$?`,
  ];
  if (plan.publish !== undefined) {
    // Atomic publish is the last wrapper step before the exit marker: an
    // exit-marker success therefore implies a completely published tree.
    wrapperLines.push(
      `if [ "$cap_job_exit" -eq 0 ]; then mv ${shellQuote(plan.publish.stagingPath)} ${shellQuote(plan.publish.finalPath)} || cap_job_exit=1; fi`,
    );
  }
  wrapperLines.push(
    `printf '%s' "$cap_job_exit" > ${shellQuote(`${paths.exit}.tmp`)} && mv -f ${shellQuote(`${paths.exit}.tmp`)} ${shellQuote(paths.exit)}`,
  );
  const wrapper = wrapperLines.join('\n');

  return [
    `mkdir -p ${shellQuote(paths.dir)}`,
    `rm -f ${shellQuote(paths.pid)} ${shellQuote(paths.exit)}`,
    `: > ${shellQuote(paths.progress)}`,
    // Subshell + background double-forks; setsid detaches the session so the
    // job survives the launching exec shell/connection teardown.
    `( setsid sh -c ${shellQuote(wrapper)} </dev/null >/dev/null 2>&1 & )`,
    `cap_i=0; while [ ! -s ${shellQuote(paths.pid)} ] && [ "$cap_i" -lt 50 ]; do sleep 0.1 2>/dev/null || sleep 1; cap_i=$((cap_i+1)); done; [ -s ${shellQuote(paths.pid)} ]`,
  ].join(' && ');
}

/**
 * Build the cheap marker-probe command. Its output is parsed by
 * {@link triageSandboxDetachedJobProbeOutput}; the probe never blocks on the
 * job and is independent of the job's own duration. The exit marker takes
 * precedence over pid liveness: the exit marker is the settlement proof.
 */
export function buildSandboxDetachedJobProbeCommand(
  jobId: string,
  markerRoot?: string,
): string {
  const paths = sandboxDetachedJobMarkerPaths(jobId, markerRoot);
  return [
    `if [ -f ${shellQuote(paths.exit)} ]; then printf 'exit %s\\n' "$(cat ${shellQuote(paths.exit)})"`,
    `elif [ -s ${shellQuote(paths.pid)} ] && kill -0 "$(cat ${shellQuote(paths.pid)})" 2>/dev/null; then printf 'alive %s\\n' "$(cat ${shellQuote(paths.pid)})"`,
    `else printf 'unknown\\n'`,
    `fi`,
    `if [ -f ${shellQuote(paths.progress)} ]; then printf 'progress %s %s\\n' "$(wc -c < ${shellQuote(paths.progress)})" "$(stat -c %Y ${shellQuote(paths.progress)} 2>/dev/null || stat -f %m ${shellQuote(paths.progress)} 2>/dev/null || printf 0)"`,
    `fi`,
  ].join('; ');
}

/** Cheap observation of the progress output stream (heartbeat input only). */
export interface SandboxDetachedJobProgressStat {
  readonly sizeBytes: number;
  readonly mtimeEpochSeconds: number;
}

/**
 * Three-way triage contract:
 * - `alive`   — pid refers to a live process and no exit marker: keep polling
 *               under the configured liveness gates.
 * - `exited`  — exit marker present: settle from its recorded exit code.
 * - `unknown` — neither liveness nor an exit marker can be proven: the probed
 *               stage MUST be settled as a typed failure, never as success and
 *               never as indefinite parking.
 */
export type SandboxDetachedJobTriage =
  | {
      readonly state: 'alive';
      readonly pid: number;
      readonly progress?: SandboxDetachedJobProgressStat;
    }
  | {
      readonly state: 'exited';
      readonly exitCode: number;
      readonly progress?: SandboxDetachedJobProgressStat;
    }
  | { readonly state: 'unknown' };

/**
 * Parse probe-command output. Anything malformed fails closed to `unknown`:
 * an unprovable job is a typed failure, not a success and not a reason to
 * wait beyond the liveness gates.
 */
export function triageSandboxDetachedJobProbeOutput(
  output: string,
): SandboxDetachedJobTriage {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const head = lines[0];
  if (head === undefined) return Object.freeze({ state: 'unknown' });

  const progress = parseProgressStat(
    lines.find((line) => line.startsWith('progress ')),
  );
  const tokens = head.split(/\s+/);

  if (tokens[0] === 'exit') {
    const exitCode = parseMarkerInteger(tokens[1]);
    if (exitCode === null) return Object.freeze({ state: 'unknown' });
    return Object.freeze({
      state: 'exited',
      exitCode,
      ...(progress === undefined ? {} : { progress }),
    });
  }
  if (tokens[0] === 'alive') {
    const pid = parseMarkerInteger(tokens[1]);
    if (pid === null || pid <= 0) return Object.freeze({ state: 'unknown' });
    return Object.freeze({
      state: 'alive',
      pid,
      ...(progress === undefined ? {} : { progress }),
    });
  }
  return Object.freeze({ state: 'unknown' });
}

/**
 * Settlement view of a triage observation. `exited` settles from the recorded
 * exit code; `unprovable` is a typed failure of the probed stage. Success is
 * never inferred from progress silence — only from an exit marker with code 0.
 */
export type SandboxDetachedJobSettlement =
  | { readonly kind: 'running' }
  | {
      readonly kind: 'exited';
      readonly outcome: 'succeeded' | 'failed';
      readonly exitCode: number;
    }
  | { readonly kind: 'unprovable' };

export function settleSandboxDetachedJobTriage(
  triage: SandboxDetachedJobTriage,
): SandboxDetachedJobSettlement {
  switch (triage.state) {
    case 'alive':
      return Object.freeze({ kind: 'running' });
    case 'exited':
      return Object.freeze({
        kind: 'exited',
        outcome: triage.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: triage.exitCode,
      });
    case 'unknown':
      return Object.freeze({ kind: 'unprovable' });
  }
}

export function isTerminalSandboxDetachedJobSettlement(
  settlement: SandboxDetachedJobSettlement,
): boolean {
  return settlement.kind !== 'running';
}

/**
 * No-resurrection guarantee: once a terminal settlement has been recorded
 * (including a stop-determined one), a later observation — e.g. a late
 * success exit marker written after a kill — can never replace it.
 */
export function reconcileSandboxDetachedJobSettlement(
  current: SandboxDetachedJobSettlement | null | undefined,
  observed: SandboxDetachedJobSettlement,
): SandboxDetachedJobSettlement {
  if (current && isTerminalSandboxDetachedJobSettlement(current)) {
    return current;
  }
  return observed;
}

/**
 * Build the kill command. Contract:
 *
 * - kills the job's process group using the identity in the pid marker
 *   (falling back to the single pid when no such group exists);
 * - idempotent: killing an already-exited job (exit marker present) or a job
 *   with no pid marker is a safe no-op and the command always exits 0 —
 *   settlement then uses the already-recorded exit marker;
 * - killing the group includes the wrapper, so a killed job writes no late
 *   success marker; the no-resurrection guarantee after terminal settlement
 *   is enforced by {@link reconcileSandboxDetachedJobSettlement} on the
 *   caller's side.
 */
export function buildSandboxDetachedJobKillCommand(
  jobId: string,
  markerRoot?: string,
): string {
  const paths = sandboxDetachedJobMarkerPaths(jobId, markerRoot);
  return [
    `if [ ! -f ${shellQuote(paths.exit)} ] && [ -s ${shellQuote(paths.pid)} ]; then`,
    `cap_pid=$(cat ${shellQuote(paths.pid)})`,
    `case "$cap_pid" in ''|*[!0-9]*) cap_pid= ;; esac`,
    `if [ -n "$cap_pid" ]; then`,
    `kill -TERM -- "-$cap_pid" 2>/dev/null || kill -TERM "$cap_pid" 2>/dev/null`,
    `cap_i=0; while kill -0 "$cap_pid" 2>/dev/null && [ "$cap_i" -lt 50 ]; do sleep 0.1 2>/dev/null || sleep 1; cap_i=$((cap_i+1)); done`,
    `kill -KILL -- "-$cap_pid" 2>/dev/null || kill -KILL "$cap_pid" 2>/dev/null`,
    `fi`,
    `fi`,
    `exit 0`,
  ].join('\n');
}

/**
 * Dual-gate liveness knobs for detached-job supervision (design D5):
 * a no-progress heartbeat window (~90s default) plus an absolute cap (~1h
 * default) as backstop. Validation follows the
 * `snapshotSandboxProvisioningPolicy` min/max pattern.
 */
export const DEFAULT_SANDBOX_DETACHED_JOB_HEARTBEAT_WINDOW_MS = 90_000;
export const SANDBOX_DETACHED_JOB_HEARTBEAT_WINDOW_MS_MIN = 1_000;
export const SANDBOX_DETACHED_JOB_HEARTBEAT_WINDOW_MS_MAX = 60 * 60_000;

export const DEFAULT_SANDBOX_DETACHED_JOB_ABSOLUTE_CAP_MS = 60 * 60_000;
export const SANDBOX_DETACHED_JOB_ABSOLUTE_CAP_MS_MIN = 1_000;
export const SANDBOX_DETACHED_JOB_ABSOLUTE_CAP_MS_MAX = 24 * 60 * 60_000;

export interface SandboxDetachedJobLivenessPolicySnapshot {
  /** Kill the job when the progress marker shows no growth/mtime advance for this window. */
  readonly heartbeatWindowMs?: number;
  /** Absolute backstop independent of progress detection. */
  readonly absoluteCapMs?: number;
}

export function snapshotSandboxDetachedJobLivenessPolicy(
  policy: SandboxDetachedJobLivenessPolicySnapshot,
): SandboxDetachedJobLivenessPolicySnapshot {
  const heartbeatWindowMs = policy.heartbeatWindowMs;
  if (
    heartbeatWindowMs !== undefined &&
    (!Number.isSafeInteger(heartbeatWindowMs) ||
      heartbeatWindowMs < SANDBOX_DETACHED_JOB_HEARTBEAT_WINDOW_MS_MIN ||
      heartbeatWindowMs > SANDBOX_DETACHED_JOB_HEARTBEAT_WINDOW_MS_MAX)
  ) {
    throw new SandboxProviderConfigurationError(
      `Sandbox detached job heartbeat window must be an integer from ${SANDBOX_DETACHED_JOB_HEARTBEAT_WINDOW_MS_MIN} to ${SANDBOX_DETACHED_JOB_HEARTBEAT_WINDOW_MS_MAX}`,
    );
  }
  const absoluteCapMs = policy.absoluteCapMs;
  if (
    absoluteCapMs !== undefined &&
    (!Number.isSafeInteger(absoluteCapMs) ||
      absoluteCapMs < SANDBOX_DETACHED_JOB_ABSOLUTE_CAP_MS_MIN ||
      absoluteCapMs > SANDBOX_DETACHED_JOB_ABSOLUTE_CAP_MS_MAX)
  ) {
    throw new SandboxProviderConfigurationError(
      `Sandbox detached job absolute cap must be an integer from ${SANDBOX_DETACHED_JOB_ABSOLUTE_CAP_MS_MIN} to ${SANDBOX_DETACHED_JOB_ABSOLUTE_CAP_MS_MAX}`,
    );
  }
  if (
    heartbeatWindowMs !== undefined &&
    absoluteCapMs !== undefined &&
    absoluteCapMs < heartbeatWindowMs
  ) {
    throw new SandboxProviderConfigurationError(
      'Sandbox detached job absolute cap must not be below the heartbeat window',
    );
  }
  return Object.freeze({
    ...(heartbeatWindowMs === undefined ? {} : { heartbeatWindowMs }),
    ...(absoluteCapMs === undefined ? {} : { absoluteCapMs }),
  });
}

/** Fill defaults over a validated snapshot (explicit values win). */
export function resolveSandboxDetachedJobLivenessPolicy(
  policy?: SandboxDetachedJobLivenessPolicySnapshot | null,
): Required<SandboxDetachedJobLivenessPolicySnapshot> {
  const snapshot = snapshotSandboxDetachedJobLivenessPolicy(policy ?? {});
  return Object.freeze({
    heartbeatWindowMs:
      snapshot.heartbeatWindowMs ??
      DEFAULT_SANDBOX_DETACHED_JOB_HEARTBEAT_WINDOW_MS,
    absoluteCapMs:
      snapshot.absoluteCapMs ?? DEFAULT_SANDBOX_DETACHED_JOB_ABSOLUTE_CAP_MS,
  });
}

function parseProgressStat(
  line: string | undefined,
): SandboxDetachedJobProgressStat | undefined {
  if (line === undefined) return undefined;
  const tokens = line.split(/\s+/);
  const sizeBytes = parseMarkerInteger(tokens[1]);
  const mtimeEpochSeconds = parseMarkerInteger(tokens[2]);
  if (
    sizeBytes === null ||
    sizeBytes < 0 ||
    mtimeEpochSeconds === null ||
    mtimeEpochSeconds < 0
  ) {
    return undefined;
  }
  return Object.freeze({ sizeBytes, mtimeEpochSeconds });
}

function parseMarkerInteger(raw: string | undefined): number | null {
  if (raw === undefined || !/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function validateAbsolutePath(value: string, label: string): string {
  if (
    !value.startsWith('/') ||
    value !== value.trim() ||
    value.includes('\n') ||
    value.length < 2 ||
    value.endsWith('/') ||
    value.split('/').some((segment, index) => index > 0 && segment === '..')
  ) {
    throw new SandboxProviderConfigurationError(
      `Sandbox detached job ${label} must be a clean absolute path`,
    );
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
