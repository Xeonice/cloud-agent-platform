import {
  createExactHostGitCredential,
  createSandboxSecretFilePort,
  type ExactHostGitCredential,
  type SandboxCommandExecutionResult,
  type SandboxGitCommandStage,
  type SandboxGitDeliveryResult,
  type SandboxGitStageExecution,
  type SandboxWorkspaceDeliveryHookContext,
  type SandboxWorkspaceFailureCause,
  type SandboxWorkspaceMaterializationHookContext,
  type SandboxWorkspaceMaterializationPlan,
  type SandboxWorkspaceMaterializationResult,
  type SandboxWorkspaceProgressEvent,
} from '@cap/sandbox-core';
import type {
  SandboxProviderConformanceAssert,
  SandboxProviderConformanceScenario,
} from './conformance.js';

const CONFORMANCE_REPOSITORY_URL =
  'https://code.example.test/acme/private.git';
const DIFFERENT_HOST_SUBMODULE_URL =
  'https://modules.example.test/acme/shared.git';
const WORKSPACE_DIR = '/home/gem/workspace';
const DELIVERY_PENDING_SENTINEL = 'CAP_DELIVERY_PENDING';

export interface SandboxGitConformanceDeadlineDriver {
  now(): number;
  schedule(delayMs: number, trigger: () => void): () => void;
}

export interface SandboxGitConformanceHelperOptions {
  readonly deadlineDriver?: SandboxGitConformanceDeadlineDriver;
}

export interface SandboxGitConformanceFailureEvidence {
  readonly stage: SandboxGitCommandStage;
  readonly result?: Pick<
    SandboxCommandExecutionResult,
    'exitCode' | 'output' | 'stdout' | 'stderr' | 'timedOut'
  >;
  readonly error?: unknown;
  readonly deadlineExceeded?: boolean;
}

export interface SandboxGitConformanceFailureClassification {
  readonly cause: SandboxWorkspaceFailureCause;
  readonly retryable: boolean;
}

/**
 * Production operations are injected by the aggregate sandbox package. This
 * keeps conformance dependent only on sandbox-core and prevents a package
 * cycle or a second classifier implementation.
 */
export interface SandboxWorkspaceGitConformanceOperations {
  materialize(
    context: SandboxWorkspaceMaterializationHookContext,
    options?: SandboxGitConformanceHelperOptions,
  ): Promise<SandboxWorkspaceMaterializationResult>;
  deliver(
    context: SandboxWorkspaceDeliveryHookContext,
    options?: SandboxGitConformanceHelperOptions,
  ): Promise<SandboxGitDeliveryResult>;
  classify(
    evidence: SandboxGitConformanceFailureEvidence,
  ): SandboxGitConformanceFailureClassification;
}

export interface SandboxWorkspaceGitConformanceOptions {
  readonly operations: SandboxWorkspaceGitConformanceOperations;
  /** One unique value reused by every secret-leak assertion in this suite. */
  readonly secretCanary: string;
}

export function createSandboxWorkspaceGitConformanceScenarios(
  options: SandboxWorkspaceGitConformanceOptions,
  assert: SandboxProviderConformanceAssert,
): readonly SandboxProviderConformanceScenario[] {
  const credential = createExactHostGitCredential(
    CONFORMANCE_REPOSITORY_URL,
    `Authorization: Basic ${options.secretCanary}`,
  );

  return [
    {
      name: 'production materialization scopes one private config and exposes no secret',
      run: () =>
        runSecureMaterializationScenario(options, credential, assert),
    },
    {
      name: 'production delivery retries without duplicate commit and cleans idempotently',
      run: () => runDeliveryRetryScenario(options, credential, assert),
    },
    {
      name: 'production cancellation waits for guest settlement before cleanup',
      run: () => runCancellationBarrierScenario(options, credential, assert),
    },
    {
      name: 'production deadline waits for guest settlement before cleanup',
      run: () => runDeadlineBarrierScenario(options, credential, assert),
    },
    {
      name: 'production classifier and materializer expose the typed failure matrix',
      run: () => runFailureMatrixScenario(options, credential, assert),
    },
  ];
}

async function runSecureMaterializationScenario(
  options: SandboxWorkspaceGitConformanceOptions,
  credential: ExactHostGitCredential,
  assert: SandboxProviderConformanceAssert,
): Promise<void> {
  const events: string[] = [];
  const secrets = createSecretFixture('materialize', events);
  const executions: SandboxGitStageExecution[] = [];
  const progress: SandboxWorkspaceProgressEvent[] = [];
  const plan = materializationPlan(credential);

  const result = await options.operations.materialize({
    taskId: 'conformance-materialize',
    plan,
    workspaceDir: WORKSPACE_DIR,
    secretFilePort: secrets.port,
    stageExecutor: {
      async execute(execution) {
        executions.push(execution);
        events.push(`stage:${execution.stage}`);
        return commandResult();
      },
    },
    onProgress: (event) => {
      progress.push(event);
    },
  });

  assert.deepEqual(
    result,
    { status: 'succeeded', stage: 'complete' },
    'production materialization must succeed',
  );
  assert.equal(secrets.configs.length, 1, 'one private config must be written');
  assert.equal(secrets.activePaths.size, 0, 'private config must not remain active');
  assert.equal(secrets.deleteCount, 1, 'private config must be deleted once');

  const config = secrets.configs[0]!.content;
  assert.ok(
    config.includes('[http "https://code.example.test/"]'),
    'credential config must be scoped to the exact repository host',
  );
  assert.ok(
    !config.includes('[http "https://modules.example.test/"]'),
    'credential config must not authorize a different-host submodule',
  );
  assert.equal(
    occurrences(config, options.secretCanary),
    1,
    'the canary must exist only once inside the provider-private config',
  );

  const transfer = executions.find(
    (execution) => execution.stage === 'workspace_transfer',
  );
  assert.ok(
    transfer?.request.command.includes('--single-branch') === true &&
      !transfer.request.command.includes('--depth'),
    'selected-branch transfer must preserve full history',
  );
  const submodules = executions.find(
    (execution) => execution.stage === 'submodules',
  );
  assert.ok(
    submodules?.request.command.includes('submodule update --init --recursive') ===
      true &&
      submodules.request.command.includes('include.path=') &&
      !submodules.request.command.includes(DIFFERENT_HOST_SUBMODULE_URL),
    'submodules must use the exact-host config without embedding their URL',
  );
  assertWorkspaceExecutionBoundary(executions, options.secretCanary, assert);

  const cleanupSucceeded = progress.findIndex(
    (event) =>
      event.stage === 'credential_cleanup' && event.status === 'succeeded',
  );
  const completed = progress.findIndex(
    (event) => event.stage === 'complete' && event.status === 'succeeded',
  );
  assert.ok(
    cleanupSucceeded >= 0 && cleanupSucceeded < completed,
    'cleanup must be durably observable before complete',
  );
  assertNoSecret(
    {
      executions,
      progress,
      result,
      logs: events,
      runMetadata: {
        taskId: 'conformance-materialize',
        plan,
        differentHostSubmodule: DIFFERENT_HOST_SUBMODULE_URL,
      },
    },
    options.secretCanary,
    'exec, progress, logs, and run metadata must be secret-free',
    assert,
  );
}

async function runDeliveryRetryScenario(
  options: SandboxWorkspaceGitConformanceOptions,
  credential: ExactHostGitCredential,
  assert: SandboxProviderConformanceAssert,
): Promise<void> {
  const events: string[] = [];
  const secrets = createSecretFixture('delivery', events);
  const executions: SandboxGitStageExecution[] = [];
  const plan = {
    branch: 'cap/conformance-delivery',
    commitMessage: 'cap: conformance delivery',
    credential,
    deadlineMs: 60_000,
  } as const;

  const executeAttempt = (attempt: 'first' | 'retry') => ({
    async execute(
      execution: SandboxGitStageExecution,
    ): Promise<SandboxCommandExecutionResult> {
      executions.push(execution);
      if (execution.stage === 'delivery_status') {
        return commandResult({
          output:
            attempt === 'first'
              ? ' M changed.txt\n'
              : `${DELIVERY_PENDING_SENTINEL}\n`,
        });
      }
      if (
        execution.stage === 'delivery_commit' &&
        execution.request.command === 'git rev-parse HEAD'
      ) {
        return commandResult({ output: 'abc123\n' });
      }
      if (execution.stage === 'delivery_push' && attempt === 'first') {
        return commandResult({
          exitCode: 1,
          stderr: 'HTTP 403 access denied',
        });
      }
      if (execution.request.command.includes('rm -f --')) {
        events.push('delivery-finalized');
      }
      return commandResult();
    },
  });

  const first = await options.operations.deliver({
    taskId: 'conformance-delivery',
    plan,
    workspaceDir: WORKSPACE_DIR,
    secretFilePort: secrets.port,
    stageExecutor: executeAttempt('first'),
  });
  assert.deepEqual(
    first,
    {
      hadChanges: true,
      commitSha: 'abc123',
      error: 'workspace_git_authentication',
    },
    'first delivery must return a typed authentication failure',
  );
  assert.equal(secrets.activePaths.size, 0, 'failed push must clean its config');

  const retry = await options.operations.deliver({
    taskId: 'conformance-delivery',
    plan,
    workspaceDir: WORKSPACE_DIR,
    secretFilePort: secrets.port,
    stageExecutor: executeAttempt('retry'),
  });
  assert.deepEqual(
    retry,
    { hadChanges: true, commitSha: 'abc123', error: null },
    'retry must push the pending commit successfully',
  );
  assert.equal(
    executions.filter((execution) =>
      execution.request.command.includes('commit -F'),
    ).length,
    1,
    'post-commit retry must not create a duplicate commit',
  );
  assert.equal(secrets.deleteCount, 2, 'each delivery attempt must clean once');
  assert.equal(secrets.activePaths.size, 0, 'repeated cleanup must remain idempotent');
  assert.ok(
    events.lastIndexOf('secret-deleted') <
      events.lastIndexOf('delivery-finalized'),
    'delivery must clean the credential before finalizing the retry marker',
  );
  assertWorkspaceExecutionBoundary(executions, options.secretCanary, assert);
  assertNoSecret(
    { executions, first, retry, logs: events, runMetadata: { plan } },
    options.secretCanary,
    'delivery exec, result, logs, and run metadata must be secret-free',
    assert,
  );
}

async function runCancellationBarrierScenario(
  options: SandboxWorkspaceGitConformanceOptions,
  credential: ExactHostGitCredential,
  assert: SandboxProviderConformanceAssert,
): Promise<void> {
  const events: string[] = [];
  const secrets = createSecretFixture('cancel', events);
  const started = deferred<void>();
  const stopped = deferred<SandboxCommandExecutionResult>();
  const cancellation = new AbortController();
  let helperSettled = false;

  const operation = options.operations
    .materialize({
      taskId: 'conformance-cancel',
      plan: materializationPlan(credential),
      workspaceDir: WORKSPACE_DIR,
      secretFilePort: secrets.port,
      cancellationSignal: cancellation.signal,
      stageExecutor: {
        async execute(execution) {
          if (execution.stage !== 'workspace_transfer') return commandResult();
          events.push('guest-started');
          started.resolve();
          const result = await stopped.promise;
          events.push('guest-stopped');
          return result;
        },
      },
    })
    .finally(() => {
      helperSettled = true;
    });

  await started.promise;
  cancellation.abort();
  assert.equal(helperSettled, false, 'abort alone must not settle the helper');
  assert.equal(
    secrets.deleteCount,
    0,
    'cleanup must wait until the guest process settlement boundary',
  );
  stopped.resolve(commandResult());
  const result = await operation;
  assert.deepEqual(
    result,
    { status: 'cancelled', stage: 'workspace_transfer' },
    'cancellation source must remain distinguishable',
  );
  assert.deepEqual(
    events.slice(-2),
    ['guest-stopped', 'secret-deleted'],
    'guest settlement must precede credential deletion',
  );
}

async function runDeadlineBarrierScenario(
  options: SandboxWorkspaceGitConformanceOptions,
  credential: ExactHostGitCredential,
  assert: SandboxProviderConformanceAssert,
): Promise<void> {
  const timing = manualDeadlineDriver();
  const events: string[] = [];
  const secrets = createSecretFixture('deadline', events);
  const started = deferred<void>();
  const stopped = deferred<SandboxCommandExecutionResult>();
  let helperSettled = false;

  const operation = options.operations
    .materialize(
      {
        taskId: 'conformance-deadline',
        plan: materializationPlan(credential, 500),
        workspaceDir: WORKSPACE_DIR,
        secretFilePort: secrets.port,
        stageExecutor: {
          async execute(execution) {
            if (execution.stage !== 'workspace_transfer') return commandResult();
            events.push('guest-started');
            started.resolve();
            const result = await stopped.promise;
            events.push('guest-stopped');
            return result;
          },
        },
      },
      { deadlineDriver: timing.driver },
    )
    .finally(() => {
      helperSettled = true;
    });

  await started.promise;
  timing.advance(500);
  assert.equal(helperSettled, false, 'deadline trigger must not race settlement');
  assert.equal(
    secrets.deleteCount,
    0,
    'deadline cleanup must wait for the guest process to stop',
  );
  stopped.resolve(commandResult());
  const result = await operation;
  assert.deepEqual(
    result,
    {
      status: 'failed',
      stage: 'workspace_transfer',
      cause: 'timeout',
      retryable: true,
    },
    'deadline source must normalize to a retryable timeout',
  );
  assert.deepEqual(
    events.slice(-2),
    ['guest-stopped', 'secret-deleted'],
    'deadline settlement must precede credential deletion',
  );
}

async function runFailureMatrixScenario(
  options: SandboxWorkspaceGitConformanceOptions,
  credential: ExactHostGitCredential,
  assert: SandboxProviderConformanceAssert,
): Promise<void> {
  const cases: readonly FailureMatrixCase[] = [
    {
      cause: 'capacity_exhausted',
      retryable: false,
      stage: 'workspace_transfer',
      result: commandResult({
        exitCode: 1,
        stderr: 'fatal: No space left on device',
      }),
    },
    {
      cause: 'timeout',
      retryable: true,
      stage: 'workspace_transfer',
      result: commandResult({ exitCode: 124, timedOut: true }),
    },
    {
      cause: 'authentication',
      retryable: false,
      stage: 'remote_ref_resolution',
      result: commandResult({
        exitCode: 1,
        stderr: 'authentication failed',
      }),
    },
    {
      cause: 'tls_network',
      retryable: true,
      stage: 'workspace_transfer',
      result: commandResult({
        exitCode: 1,
        stderr: 'SSL certificate problem',
      }),
    },
    {
      cause: 'ref_not_found',
      retryable: false,
      stage: 'remote_ref_resolution',
      result: commandResult({ exitCode: 2 }),
    },
    {
      cause: 'unknown',
      retryable: false,
      stage: 'checkout',
      result: commandResult({
        exitCode: 1,
        stderr: 'unrecognized provider failure',
      }),
    },
  ];

  for (const item of cases) {
    const classified = options.operations.classify({
      stage: item.stage,
      result: item.result,
    });
    assert.deepEqual(
      classified,
      { cause: item.cause, retryable: item.retryable },
      `central classifier must return ${item.cause}`,
    );

    const events: string[] = [];
    const secrets = createSecretFixture(`matrix-${item.cause}`, events);
    const executions: SandboxGitStageExecution[] = [];
    const progress: SandboxWorkspaceProgressEvent[] = [];
    const materialized = await options.operations.materialize({
      taskId: `conformance-${item.cause}`,
      plan: materializationPlan(credential),
      workspaceDir: WORKSPACE_DIR,
      secretFilePort: secrets.port,
      stageExecutor: {
        async execute(execution) {
          executions.push(execution);
          return execution.stage === item.stage
            ? item.result
            : commandResult();
        },
      },
      onProgress: (event) => {
        progress.push(event);
      },
    });
    assert.deepEqual(
      materialized,
      {
        status: 'failed',
        stage: item.stage,
        cause: item.cause,
        retryable: item.retryable,
      },
      `materializer must propagate ${item.cause} without raw diagnostics`,
    );
    assert.equal(
      secrets.activePaths.size,
      0,
      `${item.cause} cleanup must leave no credential file`,
    );
    assert.equal(
      secrets.deleteCount,
      1,
      `${item.cause} cleanup must execute exactly once`,
    );
    assertWorkspaceExecutionBoundary(executions, options.secretCanary, assert);
    assertNoSecret(
      { classified, materialized, progress, executions, logs: events },
      options.secretCanary,
      `${item.cause} public surfaces must exclude raw diagnostics`,
      assert,
    );
  }
}

interface FailureMatrixCase {
  readonly cause: SandboxWorkspaceFailureCause;
  readonly retryable: boolean;
  readonly stage: Extract<
    SandboxGitCommandStage,
    | 'remote_ref_resolution'
    | 'workspace_transfer'
    | 'checkout'
    | 'submodules'
  >;
  readonly result: SandboxCommandExecutionResult;
}

function materializationPlan(
  credential: ExactHostGitCredential,
  deadlineMs = 60_000,
): SandboxWorkspaceMaterializationPlan {
  return {
    repositoryUrl: CONFORMANCE_REPOSITORY_URL,
    callerBranch: null,
    resolvedBranch: 'master',
    deadlineMs,
    credential,
  };
}

interface SecretFixture {
  readonly port: ReturnType<typeof createSandboxSecretFilePort>;
  readonly configs: Array<{
    readonly path: string;
    readonly mode: number;
    readonly content: string;
  }>;
  readonly activePaths: Set<string>;
  readonly deleteCount: number;
}

function createSecretFixture(prefix: string, events: string[]): SecretFixture {
  let sequence = 0;
  let deleteCount = 0;
  const configs: SecretFixture['configs'] = [];
  const activePaths = new Set<string>();
  const port = createSandboxSecretFilePort({
    directory: '/run/cap-secrets',
    createId: () => `${prefix}-${++sequence}`,
    transport: {
      async writeFile(request) {
        configs.push({
          path: request.path,
          mode: request.mode,
          content: Buffer.from(request.content).toString('utf8'),
        });
        activePaths.add(request.path);
        events.push('secret-written');
      },
      async deleteFile(request) {
        activePaths.delete(request.path);
        deleteCount += 1;
        events.push('secret-deleted');
      },
    },
  });
  return {
    port,
    configs,
    activePaths,
    get deleteCount() {
      return deleteCount;
    },
  };
}

function assertWorkspaceExecutionBoundary(
  executions: readonly SandboxGitStageExecution[],
  secretCanary: string,
  assert: SandboxProviderConformanceAssert,
): void {
  for (const execution of executions) {
    assert.equal(
      execution.request.signal,
      execution.signal,
      'command request and stage must share one cancellation signal',
    );
    assert.equal(
      execution.request.timeoutMs,
      execution.remainingTimeoutMs,
      'command timeout must equal the remaining operation deadline',
    );
    for (const forbidden of [
      'argv',
      'env',
      'stdin',
      'authHeader',
      'credential',
      'secret',
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(execution.request, forbidden),
        false,
        `${forbidden} must be absent from ordinary workspace exec`,
      );
    }
    assert.ok(
      !execution.request.command.includes(secretCanary),
      'workspace command must reference only the private config path',
    );
  }
}

function assertNoSecret(
  value: unknown,
  secretCanary: string,
  message: string,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.equal(JSON.stringify(value).includes(secretCanary), false, message);
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function commandResult(
  overrides: Partial<SandboxCommandExecutionResult> = {},
): SandboxCommandExecutionResult {
  return {
    exitCode: 0,
    output: '',
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function manualDeadlineDriver(): {
  readonly driver: SandboxGitConformanceDeadlineDriver;
  advance(milliseconds: number): void;
} {
  let now = 0;
  const scheduled: Array<{
    readonly at: number;
    readonly trigger: () => void;
    cancelled: boolean;
  }> = [];
  return {
    driver: {
      now: () => now,
      schedule(delayMs, trigger) {
        const entry = { at: now + delayMs, trigger, cancelled: false };
        scheduled.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const entry of scheduled) {
        if (!entry.cancelled && entry.at <= now) {
          entry.cancelled = true;
          entry.trigger();
        }
      }
    },
  };
}
