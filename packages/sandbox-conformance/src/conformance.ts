import {
  SANDBOX_EXECUTION_MODES,
  type AgentTerminalLaunchOutcome,
  type AgentTerminalPty,
  type SandboxConnection,
  type SandboxCommandDescriptorPort,
  type SandboxCommandEndpointDescriptor,
  type SandboxCommandExecutionRequest,
  type SandboxCommandExecutionResult,
  type SandboxCommandExecutor,
  type SandboxDeliverWorkspaceArgs,
  type SandboxDeliverWorkspaceResult,
  type SandboxProviderPort,
  type SandboxProvisionContext,
  type SandboxReadoptionPort,
  type SandboxReadoptionTarget,
  type SandboxResourceSnapshot,
  type SandboxResolvedEnvironmentMetadata,
  type SandboxRetentionDescriptorPort,
  type SandboxSelectedRunPort,
  type SandboxTerminalDescriptorPort,
  type SandboxTerminalEndpointDescriptor,
  type SandboxTranscriptSourceBase,
  type SandboxWorkspaceDescriptor,
  type SandboxWorkspaceDescriptorPort,
  type SandboxWorkspaceMaterializationPlan,
  type SandboxWorkspaceProgressReporter,
  type SelectedSandboxRun,
  type TaskModelIntent,
} from '@cap/sandbox-core';
import {
  createExactHostGitCredential,
  missingCapabilities,
  resourcesForSandboxProvision,
  sandboxResourceRequiredCapabilities,
  snapshotSandboxProvisionContext,
  type SandboxProviderCapability,
} from '@cap/sandbox-core';

export interface SandboxProviderConformanceOptions<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
> {
  readonly provider: SandboxProviderPort<TCloneSpec, TRuntimeId, TTranscriptSource> &
    Partial<SandboxReadoptionPort> &
    Partial<SandboxSelectedRunPort> &
    Partial<SandboxTerminalDescriptorPort> &
    Partial<SandboxCommandDescriptorPort> &
    Partial<SandboxWorkspaceDescriptorPort> &
    Partial<SandboxRetentionDescriptorPort>;
  readonly taskId: string;
  readonly requiredCapabilities?: readonly SandboxProviderCapability[];
  readonly cloneSpec?: TCloneSpec | null;
  readonly runtimeId?: TRuntimeId | null;
  readonly modelIntent?: TaskModelIntent;
  readonly executionMode?: 'interactive-pty' | 'headless-exec';
  readonly environment?: SandboxResolvedEnvironmentMetadata | null;
  readonly resources?: SandboxResourceSnapshot;
  readonly workspace?: SandboxWorkspaceMaterializationPlan | null;
  readonly cancellationSignal?: AbortSignal;
  readonly onWorkspaceProgress?: SandboxWorkspaceProgressReporter;
  readonly deliverArgs?: SandboxDeliverWorkspaceArgs;
  /**
   * Set to false for providers whose fake/test backend intentionally does not
   * expose retained transcripts in this scenario.
   */
  readonly expectTranscriptSource?: boolean;
  /**
   * Set to false when the provider does not declare `lifecycle.readopt`.
   */
  readonly expectReadoption?: boolean;
  /**
   * Set to true for providers that should expose a selected-run descriptor during
   * conformance. Kept opt-in so existing connection-only adapters remain valid.
   */
  readonly expectSelectedRun?: boolean;
}

type SandboxBehaviorMaybePromise<T> = T | Promise<T>;

export interface SandboxProviderBehaviorContext<TCloneSpec = unknown> {
  readonly taskId: string;
  readonly providerId: string;
  readonly provisionContext: SandboxProvisionContext<TCloneSpec>;
  readonly connection: SandboxConnection;
  readonly selectedRun: SelectedSandboxRun;
}

interface SandboxProviderBehaviorTraceIdentity {
  readonly sequence: number;
  readonly taskId: string;
  readonly providerId: string;
}

export type SandboxTerminalBehaviorTraceEvent =
  | (SandboxProviderBehaviorTraceIdentity & {
      readonly kind: 'attach';
      readonly outcome: Extract<
        AgentTerminalLaunchOutcome['kind'],
        'attached' | 'launched'
      >;
    })
  | (SandboxProviderBehaviorTraceIdentity & {
      readonly kind: 'output' | 'input';
      readonly data: string;
    })
  | (SandboxProviderBehaviorTraceIdentity & {
      readonly kind: 'resize';
      readonly cols: number;
      readonly rows: number;
    })
  | (SandboxProviderBehaviorTraceIdentity & {
      readonly kind: 'close' | 'replacement';
    });

export interface SandboxTerminalBehaviorSession {
  readonly taskId: string;
  readonly providerId: string;
  readonly terminal: AgentTerminalPty;
  emitProviderOutput(data: string): SandboxBehaviorMaybePromise<void>;
}

export interface SandboxTerminalBehaviorConformanceAdapter<TCloneSpec = unknown> {
  open(
    context: SandboxProviderBehaviorContext<TCloneSpec>,
  ): SandboxBehaviorMaybePromise<SandboxTerminalBehaviorSession>;
  replace(args: {
    readonly context: SandboxProviderBehaviorContext<TCloneSpec>;
    readonly previous: SandboxTerminalBehaviorSession;
  }): SandboxBehaviorMaybePromise<SandboxTerminalBehaviorSession>;
  readTrace(): SandboxBehaviorMaybePromise<readonly SandboxTerminalBehaviorTraceEvent[]>;
}

export type SandboxCommandBehaviorTraceEvent =
  | (SandboxProviderBehaviorTraceIdentity & {
      readonly kind: 'execute';
    })
  | (SandboxProviderBehaviorTraceIdentity & {
      readonly kind: 'settled';
      readonly exitCode: number;
      readonly timedOut: boolean;
    });

export interface SandboxCommandBehaviorSession {
  readonly taskId: string;
  readonly providerId: string;
  readonly executor: SandboxCommandExecutor;
}

export interface SandboxCommandBehaviorConformanceAdapter<TCloneSpec = unknown> {
  open(
    context: SandboxProviderBehaviorContext<TCloneSpec>,
  ): SandboxBehaviorMaybePromise<SandboxCommandBehaviorSession>;
  readTrace(): SandboxBehaviorMaybePromise<readonly SandboxCommandBehaviorTraceEvent[]>;
}

export type SandboxWorkspaceBehaviorTraceEvent =
  | (SandboxProviderBehaviorTraceIdentity & {
      readonly kind:
        | 'materialize-start'
        | 'materialize-operation'
        | 'delivery-start'
        | 'delivery-command';
      readonly sandboxTaskId: string;
    })
  | (SandboxProviderBehaviorTraceIdentity & {
      readonly kind: 'materialize-settled' | 'delivery-settled';
      readonly sandboxTaskId: string;
      readonly outcome: 'succeeded' | 'failed';
    });

export interface SandboxWorkspaceBehaviorConformanceAdapter {
  readTrace(): SandboxBehaviorMaybePromise<readonly SandboxWorkspaceBehaviorTraceEvent[]>;
}

export type SandboxOwnershipBehaviorTraceEvent =
  | (SandboxProviderBehaviorTraceIdentity & {
      readonly kind: 'provider-selected' | 'readoptable-listed';
    })
  | (SandboxProviderBehaviorTraceIdentity & {
      readonly kind: 'reattached';
      readonly providerSandboxIdMatched: true;
      readonly ownershipFenceMatched: true;
    });

export interface SandboxOwnershipBehaviorConformanceAdapter<TCloneSpec = unknown> {
  readoptionTarget(
    context: SandboxProviderBehaviorContext<TCloneSpec>,
  ): SandboxBehaviorMaybePromise<SandboxReadoptionTarget>;
  readTrace(): SandboxBehaviorMaybePromise<readonly SandboxOwnershipBehaviorTraceEvent[]>;
}

export interface SandboxProviderBehaviorConformanceAdapters<
  TCloneSpec = unknown,
> {
  readonly terminal?: SandboxTerminalBehaviorConformanceAdapter<TCloneSpec>;
  readonly command?: SandboxCommandBehaviorConformanceAdapter<TCloneSpec>;
  readonly workspace?: SandboxWorkspaceBehaviorConformanceAdapter;
  readonly ownership?: SandboxOwnershipBehaviorConformanceAdapter<TCloneSpec>;
}

export interface SandboxProviderBehaviorConformanceOptions<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
> extends SandboxProviderConformanceOptions<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  > {
  readonly behavior: SandboxProviderBehaviorConformanceAdapters<TCloneSpec>;
}

export interface SandboxProviderConformanceScenario {
  readonly name: string;
  run(): Promise<void>;
}

export interface SandboxProviderConformanceAssert {
  ok(value: unknown, message: string): void;
  equal<T>(actual: T, expected: T, message: string): void;
  deepEqual<T>(actual: T, expected: T, message: string): void;
}

export function createSandboxProviderConformanceScenarios<
  TCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
>(
  options: SandboxProviderConformanceOptions<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  >,
  assert: SandboxProviderConformanceAssert,
): readonly SandboxProviderConformanceScenario[] {
  const taskId = options.taskId;
  const deliverArgs =
    options.deliverArgs ??
    ({
      credential: createExactHostGitCredential(
        'https://conformance.invalid/repository.git',
        'Authorization: Basic test-token',
      ),
      branch: `cap/${taskId}`,
      commitMessage: 'CAP sandbox conformance',
    } satisfies SandboxDeliverWorkspaceArgs);
  const provisionContext = snapshotSandboxProvisionContext({
    taskId,
    cloneSpec: options.cloneSpec,
    modelIntent: options.modelIntent ?? ({ kind: 'runtime-default' } as const),
    runtimeId: String(options.runtimeId ?? 'codex'),
    executionMode: options.executionMode ?? ('interactive-pty' as const),
    environment: options.environment,
    resources: options.resources,
    workspace: options.workspace,
    cancellationSignal: options.cancellationSignal,
    onWorkspaceProgress: options.onWorkspaceProgress,
  });

  const scenarios: SandboxProviderConformanceScenario[] = [
    {
      name: 'provider declares a valid execution mode and required capabilities',
      async run() {
        assert.ok(
          SANDBOX_EXECUTION_MODES.includes(options.provider.getSandboxMode()),
          'sandbox mode must be one of the shared execution modes',
        );
        const capabilities = options.provider.getProviderCapabilities?.();
        assert.ok(Array.isArray(capabilities), 'provider must declare capabilities');
        const required = new Set(options.requiredCapabilities ?? []);
        for (const capability of sandboxResourceRequiredCapabilities(
          resourcesForSandboxProvision(provisionContext),
        )) {
          required.add(capability);
        }
        const missing = missingCapabilities(capabilities ?? [], [...required]);
        assert.deepEqual(missing, [], 'provider is missing required capabilities');
      },
    },
    {
      name: 'provision returns an addressable task connection',
      async run() {
        const connection = await options.provider.provision(provisionContext);
        assertSandboxConnection(connection, taskId, assert);
      },
    },
    {
      name: 'provision is idempotent for the same task and cloneSpec',
      async run() {
        const first = await options.provider.provision(provisionContext);
        const second = await options.provider.provision(provisionContext);
        assertSandboxConnection(first, taskId, assert);
        assert.deepEqual(
          second,
          first,
          'provision must return a stable connection for repeated task provisioning',
        );
      },
    },
    {
      name: 'sandbox existence check returns a boolean',
      async run() {
        const exists = await options.provider.sandboxExists(taskId);
        assert.equal(typeof exists, 'boolean', 'sandboxExists must resolve to a boolean');
      },
    },
    {
      name: 'workspace delivery returns the shared delivery result shape',
      async run() {
        const result = await options.provider.deliverWorkspaceChanges(taskId, deliverArgs);
        assertSandboxDeliverWorkspaceResult(result, assert);
      },
    },
    {
      name: 'retained transcript read returns null or a tagged source',
      async run() {
        const source = await options.provider.readRolloutFromContainer(
          taskId,
          options.runtimeId,
        );
        if (options.expectTranscriptSource === false) {
          assert.equal(source, null, 'transcript source should be absent in this scenario');
          return;
        }
        if (source === null) {
          assert.ok(false, 'transcript source should be present');
          return;
        }
        assertSandboxTranscriptSource(source, assert);
      },
    },
    {
      name: 'readoption surfaces are present when lifecycle.readopt is declared',
      async run() {
        const shouldReadopt =
          options.expectReadoption ??
          options.provider
            .getProviderCapabilities?.()
            ?.some((capability) =>
              capability === 'lifecycle.readopt' ||
              capability === 'lifecycle.readoption',
            ) === true;
        if (!shouldReadopt) return;
        assert.equal(
          typeof options.provider.listReadoptable,
          'function',
          'readoptable provider must expose listReadoptable',
        );
        assert.equal(
          typeof options.provider.reattach,
          'function',
          'readoptable provider must expose reattach',
        );
        const readoptable = await options.provider.listReadoptable?.();
        assert.ok(Array.isArray(readoptable), 'listReadoptable must resolve to an array');
        const reattached = await options.provider.reattach?.(taskId);
        if (reattached !== null && reattached !== undefined) {
          assertSandboxConnection(reattached, taskId, assert);
        }
      },
    },
    {
      name: 'teardown is callable at the end of the provider lifecycle',
      async run() {
        await options.provider.teardownSandbox(taskId);
      },
    },
  ];

  scenarios.push(...createFeatureConformanceScenarios(options, assert));

  return scenarios;
}

const TERMINAL_BEHAVIOR_INPUT = 'cap-conformance-input\n';
const TERMINAL_BEHAVIOR_OUTPUT = 'cap-conformance-output\n';
const TERMINAL_BEHAVIOR_COLS = 91;
const TERMINAL_BEHAVIOR_ROWS = 37;
const COMMAND_BEHAVIOR_REQUEST = Object.freeze({
  command: 'printf cap-command-conformance',
  cwd: '/workspace',
  timeoutMs: 30_000,
}) satisfies SandboxCommandExecutionRequest;

/**
 * Executable, provider-owned behavior conformance. This remains separate from
 * the baseline descriptor suite so provider families can opt in with their real
 * fake transport/executor/ownership seams without weakening existing adapters.
 * The adapter drives provider test infrastructure; this suite owns every action
 * and exact trace assertion.
 */
export function createSandboxProviderBehaviorConformanceScenarios<
  TCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
>(
  options: SandboxProviderBehaviorConformanceOptions<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  >,
  assert: SandboxProviderConformanceAssert,
): readonly SandboxProviderConformanceScenario[] {
  const capabilities = options.provider.getProviderCapabilities?.() ?? [];
  const needsTerminal = capabilities.includes('terminal.interactive');
  const needsCommand = capabilities.includes('command.exec');
  const needsWorkspace = capabilities.some((capability) =>
    capability === 'workspace.git.materialize' ||
    capability === 'workspace.git.deliver' ||
    capability === 'workspace.archive.transfer',
  );
  const needsOwnership = capabilities.some((capability) =>
    capability === 'lifecycle.readopt' || capability === 'lifecycle.readoption',
  );
  const provisionContext = snapshotSandboxProvisionContext({
    taskId: options.taskId,
    cloneSpec: options.cloneSpec,
    modelIntent: options.modelIntent ?? ({ kind: 'runtime-default' } as const),
    runtimeId: String(options.runtimeId ?? 'codex'),
    executionMode: options.executionMode ?? ('interactive-pty' as const),
    environment: options.environment,
    resources: options.resources,
    workspace: options.workspace,
    cancellationSignal: options.cancellationSignal,
    onWorkspaceProgress: options.onWorkspaceProgress,
  });
  const deliverArgs =
    options.deliverArgs ??
    ({
      credential: createExactHostGitCredential(
        'https://conformance.invalid/repository.git',
        'Authorization: Basic behavior-token',
      ),
      branch: `cap/${options.taskId}`,
      commitMessage: 'CAP sandbox behavior conformance',
    } satisfies SandboxDeliverWorkspaceArgs);
  let contextPromise:
    | Promise<SandboxProviderBehaviorContext<TCloneSpec>>
    | undefined;
  const getContext = () => {
    contextPromise ??= resolveProviderBehaviorContext(
      options,
      provisionContext,
      assert,
    );
    return contextPromise;
  };

  const scenarios: SandboxProviderConformanceScenario[] = [
    {
      name: 'behavior adapters cover every advertised provider-owned capability',
      async run() {
        assert.ok(
          !needsTerminal || options.behavior.terminal !== undefined,
          'interactive terminal capability requires a behavior adapter',
        );
        assert.ok(
          !needsCommand || options.behavior.command !== undefined,
          'command execution capability requires a behavior adapter',
        );
        assert.ok(
          !needsWorkspace || options.behavior.workspace !== undefined,
          'workspace capability requires a behavior adapter',
        );
        assert.ok(
          !needsOwnership || options.behavior.ownership !== undefined,
          'readoption capability requires an ownership behavior adapter',
        );
      },
    },
  ];

  if (needsTerminal && options.behavior.terminal !== undefined) {
    scenarios.push({
      name: 'interactive terminal behavior preserves attach and replacement ownership',
      run: () =>
        runTerminalBehaviorConformance(
          getContext,
          options.behavior.terminal!,
          assert,
        ),
    });
  }

  if (needsCommand && options.behavior.command !== undefined) {
    scenarios.push({
      name: 'command executor behavior runs in the selected provider task',
      run: () =>
        runCommandBehaviorConformance(
          getContext,
          options.behavior.command!,
          assert,
        ),
    });
  }

  if (needsWorkspace && options.behavior.workspace !== undefined) {
    scenarios.push({
      name: 'workspace behavior materializes and delivers in the selected provider task',
      run: () =>
        runWorkspaceBehaviorConformance({
          getContext,
          provider: options.provider,
          adapter: options.behavior.workspace!,
          capabilities,
          workspace: provisionContext.workspace,
          deliverArgs,
          assert,
        }),
    });
  }

  if (needsOwnership && options.behavior.ownership !== undefined) {
    scenarios.push({
      name: 'ownership behavior readopts only the selected provider task',
      run: () =>
        runOwnershipBehaviorConformance({
          getContext,
          provider: options.provider,
          adapter: options.behavior.ownership!,
          assert,
        }),
    });
  }

  return scenarios;
}

async function resolveProviderBehaviorContext<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
>(
  options: SandboxProviderBehaviorConformanceOptions<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  >,
  provisionContext: SandboxProvisionContext<TCloneSpec>,
  assert: SandboxProviderConformanceAssert,
): Promise<SandboxProviderBehaviorContext<TCloneSpec>> {
  const connection = await options.provider.provision(provisionContext);
  assertSandboxConnection(connection, options.taskId, assert);
  assert.equal(
    typeof options.provider.getSelectedSandboxRun,
    'function',
    'behavior conformance requires the selected-run ownership surface',
  );
  const selectedRun = await options.provider.getSelectedSandboxRun?.(
    options.taskId,
  );
  if (selectedRun === null || selectedRun === undefined) {
    throw new Error('Behavior conformance requires a selected provider run');
  }
  assertSelectedSandboxRun(selectedRun, options.taskId, assert);
  return Object.freeze({
    taskId: options.taskId,
    providerId: selectedRun.providerId,
    provisionContext,
    connection,
    selectedRun,
  });
}

async function runTerminalBehaviorConformance<TCloneSpec>(
  getContext: () => Promise<SandboxProviderBehaviorContext<TCloneSpec>>,
  adapter: SandboxTerminalBehaviorConformanceAdapter<TCloneSpec>,
  assert: SandboxProviderConformanceAssert,
): Promise<void> {
  const context = await getContext();
  const first = await adapter.open(context);
  assertBehaviorSessionIdentity(first, context, 'terminal', assert);
  const output: string[] = [];
  const subscription = first.terminal.onData((chunk) => output.push(chunk));
  const firstOutcome = await requireSuccessfulAttach(
    first.terminal.launchDecision,
    assert,
  );
  await first.emitProviderOutput(TERMINAL_BEHAVIOR_OUTPUT);
  first.terminal.write(TERMINAL_BEHAVIOR_INPUT);
  first.terminal.resize(TERMINAL_BEHAVIOR_COLS, TERMINAL_BEHAVIOR_ROWS);
  if (typeof first.terminal.close !== 'function') {
    subscription.dispose();
    throw new Error('Interactive terminal behavior requires close support');
  }
  first.terminal.close();

  const replacement = await adapter.replace({ context, previous: first });
  assertBehaviorSessionIdentity(replacement, context, 'replacement terminal', assert);
  assert.ok(
    replacement.terminal !== first.terminal,
    'replacement must expose a distinct terminal handle',
  );
  const replacementOutcome = await requireSuccessfulAttach(
    replacement.terminal.launchDecision,
    assert,
  );
  const expected: readonly SandboxTerminalBehaviorTraceEvent[] = [
    traceIdentity(context, 1, { kind: 'attach', outcome: firstOutcome }),
    traceIdentity(context, 2, {
      kind: 'output',
      data: TERMINAL_BEHAVIOR_OUTPUT,
    }),
    traceIdentity(context, 3, {
      kind: 'input',
      data: TERMINAL_BEHAVIOR_INPUT,
    }),
    traceIdentity(context, 4, {
      kind: 'resize',
      cols: TERMINAL_BEHAVIOR_COLS,
      rows: TERMINAL_BEHAVIOR_ROWS,
    }),
    traceIdentity(context, 5, { kind: 'close' }),
    traceIdentity(context, 6, { kind: 'replacement' }),
    traceIdentity(context, 7, {
      kind: 'attach',
      outcome: replacementOutcome,
    }),
  ];
  assert.deepEqual(
    await adapter.readTrace(),
    expected,
    'terminal behavior trace must preserve action order and ownership',
  );
  assert.deepEqual(
    output,
    [TERMINAL_BEHAVIOR_OUTPUT],
    'provider output must reach the selected terminal exactly once',
  );
  subscription.dispose();
  replacement.terminal.close?.();
}

async function runCommandBehaviorConformance<TCloneSpec>(
  getContext: () => Promise<SandboxProviderBehaviorContext<TCloneSpec>>,
  adapter: SandboxCommandBehaviorConformanceAdapter<TCloneSpec>,
  assert: SandboxProviderConformanceAssert,
): Promise<void> {
  const context = await getContext();
  const session = await adapter.open(context);
  assertBehaviorSessionIdentity(session, context, 'command executor', assert);
  const result = await session.executor.exec(COMMAND_BEHAVIOR_REQUEST);
  assertSandboxCommandExecutionResult(result, assert);
  const expected: readonly SandboxCommandBehaviorTraceEvent[] = [
    traceIdentity(context, 1, { kind: 'execute' }),
    traceIdentity(context, 2, {
      kind: 'settled',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    }),
  ];
  assert.deepEqual(
    await adapter.readTrace(),
    expected,
    'command behavior trace must prove selected provider execution and settlement',
  );
}

async function runWorkspaceBehaviorConformance<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
>(args: {
  readonly getContext: () => Promise<SandboxProviderBehaviorContext<TCloneSpec>>;
  readonly provider: SandboxProviderBehaviorConformanceOptions<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  >['provider'];
  readonly adapter: SandboxWorkspaceBehaviorConformanceAdapter;
  readonly capabilities: readonly SandboxProviderCapability[];
  readonly workspace: SandboxWorkspaceMaterializationPlan | null | undefined;
  readonly deliverArgs: SandboxDeliverWorkspaceArgs;
  readonly assert: SandboxProviderConformanceAssert;
}): Promise<void> {
  const materializes = args.capabilities.some((capability) =>
    capability === 'workspace.git.materialize' ||
    capability === 'workspace.archive.transfer',
  );
  const delivers = args.capabilities.includes('workspace.git.deliver');
  if (
    materializes &&
    (args.workspace === null || args.workspace === undefined)
  ) {
    throw new Error(
      'Workspace behavior conformance requires a staged materialization plan',
    );
  }
  const context = await args.getContext();
  let delivery: SandboxDeliverWorkspaceResult | undefined;
  if (delivers) {
    delivery = await args.provider.deliverWorkspaceChanges(
      context.taskId,
      args.deliverArgs,
    );
    assertSandboxDeliverWorkspaceResult(delivery, args.assert);
    args.assert.equal(
      delivery.error,
      null,
      'workspace behavior delivery must demonstrate a successful provider-owned command path',
    );
  }

  const expected: SandboxWorkspaceBehaviorTraceEvent[] = [];
  let sequence = 0;
  if (materializes) {
    expected.push(
      traceIdentity(context, ++sequence, {
        kind: 'materialize-start',
        sandboxTaskId: context.taskId,
      }),
      traceIdentity(context, ++sequence, {
        kind: 'materialize-operation',
        sandboxTaskId: context.taskId,
      }),
      traceIdentity(context, ++sequence, {
        kind: 'materialize-settled',
        sandboxTaskId: context.taskId,
        outcome: 'succeeded',
      }),
    );
  }
  if (delivers) {
    expected.push(
      traceIdentity(context, ++sequence, {
        kind: 'delivery-start',
        sandboxTaskId: context.taskId,
      }),
      traceIdentity(context, ++sequence, {
        kind: 'delivery-command',
        sandboxTaskId: context.taskId,
      }),
      traceIdentity(context, ++sequence, {
        kind: 'delivery-settled',
        sandboxTaskId: context.taskId,
        outcome: 'succeeded',
      }),
    );
  }
  args.assert.deepEqual(
    await args.adapter.readTrace(),
    expected,
    'workspace behavior trace must prove materialization and delivery executor ownership',
  );
}

async function runOwnershipBehaviorConformance<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
>(args: {
  readonly getContext: () => Promise<SandboxProviderBehaviorContext<TCloneSpec>>;
  readonly provider: SandboxProviderBehaviorConformanceOptions<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  >['provider'];
  readonly adapter: SandboxOwnershipBehaviorConformanceAdapter<TCloneSpec>;
  readonly assert: SandboxProviderConformanceAssert;
}): Promise<void> {
  const context = await args.getContext();
  const owner = context.selectedRun.owner;
  if (owner !== undefined) {
    args.assert.equal(owner.taskId, context.taskId, 'selected run owner taskId must match');
    args.assert.equal(
      owner.providerId,
      context.providerId,
      'selected run owner providerId must match',
    );
  }
  args.assert.ok(
    typeof context.selectedRun.providerSandboxId === 'string' &&
      context.selectedRun.providerSandboxId.length > 0,
    'ownership behavior requires a selected provider sandbox id',
  );
  args.assert.equal(
    typeof args.provider.listReadoptable,
    'function',
    'ownership behavior requires listReadoptable',
  );
  args.assert.equal(
    typeof args.provider.reattach,
    'function',
    'ownership behavior requires reattach',
  );
  const readoptable = await args.provider.listReadoptable?.();
  args.assert.ok(
    readoptable?.includes(context.taskId) === true,
    'selected task must be listed as readoptable',
  );
  const target = await args.adapter.readoptionTarget(context);
  args.assert.equal(
    target.providerSandboxId,
    context.selectedRun.providerSandboxId,
    'readoption target must select the exact provider sandbox',
  );
  args.assert.ok(
    typeof target.ownership?.ownerGeneration === 'string' &&
      target.ownership.ownerGeneration.length > 0 &&
      typeof target.ownership.resourceGeneration === 'string' &&
      target.ownership.resourceGeneration.length > 0,
    'readoption target must carry a complete ownership fence',
  );
  const reattached = await args.provider.reattach?.(context.taskId, target);
  if (reattached === null || reattached === undefined) {
    throw new Error('Selected provider task must be reattached');
  }
  assertSandboxConnection(reattached, context.taskId, args.assert);
  const expected: readonly SandboxOwnershipBehaviorTraceEvent[] = [
    traceIdentity(context, 1, { kind: 'provider-selected' }),
    traceIdentity(context, 2, { kind: 'readoptable-listed' }),
    traceIdentity(context, 3, {
      kind: 'reattached',
      providerSandboxIdMatched: true,
      ownershipFenceMatched: true,
    }),
  ];
  args.assert.deepEqual(
    await args.adapter.readTrace(),
    expected,
    'ownership trace must prove selected provider readoption order and identity',
  );
}

function traceIdentity<
  TCloneSpec,
  const TEvent extends Record<string, unknown>,
>(
  context: SandboxProviderBehaviorContext<TCloneSpec>,
  sequence: number,
  event: TEvent,
): SandboxProviderBehaviorTraceIdentity & TEvent {
  return {
    sequence,
    taskId: context.taskId,
    providerId: context.providerId,
    ...event,
  };
}

function assertBehaviorSessionIdentity<
  TCloneSpec,
  TSession extends { readonly taskId: string; readonly providerId: string },
>(
  session: TSession,
  context: SandboxProviderBehaviorContext<TCloneSpec>,
  label: string,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.equal(session.taskId, context.taskId, `${label} taskId must match`);
  assert.equal(
    session.providerId,
    context.providerId,
    `${label} providerId must match`,
  );
}

async function requireSuccessfulAttach(
  outcomePromise: Promise<AgentTerminalLaunchOutcome>,
  assert: SandboxProviderConformanceAssert,
): Promise<'attached' | 'launched'> {
  const outcome = await outcomePromise;
  const succeeded = outcome.kind === 'attached' || outcome.kind === 'launched';
  assert.ok(succeeded, 'terminal launch decision must prove attach or launch');
  if (!succeeded) {
    throw new Error('Terminal behavior did not establish an attachable session');
  }
  return outcome.kind;
}

export function assertSandboxCommandExecutionResult(
  result: SandboxCommandExecutionResult,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(Number.isSafeInteger(result.exitCode), 'command exitCode must be a safe integer');
  assert.equal(typeof result.output, 'string', 'command output must be a string');
  assert.equal(typeof result.stdout, 'string', 'command stdout must be a string');
  assert.equal(typeof result.stderr, 'string', 'command stderr must be a string');
  assert.equal(typeof result.timedOut, 'boolean', 'command timedOut must be boolean');
}

export function assertSandboxConnection(
  connection: SandboxConnection,
  expectedTaskId: string | undefined,
  assert: SandboxProviderConformanceAssert,
): void {
  if (expectedTaskId !== undefined) {
    assert.equal(connection.taskId, expectedTaskId, 'connection taskId must match');
  }
  assert.ok(typeof connection.baseUrl === 'string' && connection.baseUrl.length > 0, 'baseUrl is required');
  assert.ok(typeof connection.wsUrl === 'string' && connection.wsUrl.length > 0, 'wsUrl is required');
}

export function assertSandboxDeliverWorkspaceResult(
  result: SandboxDeliverWorkspaceResult,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.equal(typeof result.hadChanges, 'boolean', 'hadChanges must be boolean');
  assert.ok(
    result.commitSha === null || typeof result.commitSha === 'string',
    'commitSha must be string or null',
  );
  assert.ok(
    result.error === null || typeof result.error === 'string',
    'error must be string or null',
  );
}

export function assertSandboxTranscriptSource(
  source: SandboxTranscriptSourceBase,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(typeof source.format === 'string' && source.format.length > 0, 'format is required');
  assert.equal(typeof source.jsonl, 'string', 'jsonl must be a string');
}

function createFeatureConformanceScenarios<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
>(
  options: SandboxProviderConformanceOptions<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  >,
  assert: SandboxProviderConformanceAssert,
): readonly SandboxProviderConformanceScenario[] {
  const capabilities = options.provider.getProviderCapabilities?.() ?? [];
  const scenarios: SandboxProviderConformanceScenario[] = [];

  if (options.expectSelectedRun === true) {
    scenarios.push({
      name: 'selected run descriptor is available when expected',
      async run() {
        assert.equal(
          typeof options.provider.getSelectedSandboxRun,
          'function',
          'selected-run provider must expose getSelectedSandboxRun',
        );
        const run = await options.provider.getSelectedSandboxRun?.(options.taskId);
        if (run === null || run === undefined) {
          assert.ok(false, 'selected run descriptor should be present');
          return;
        }
        assertSelectedSandboxRun(run, options.taskId, assert);
      },
    });
  }

  if (capabilities.includes('terminal.interactive')) {
    scenarios.push({
      name: 'interactive terminal capability exposes a terminal descriptor',
      async run() {
        assert.equal(
          typeof options.provider.getTerminalDescriptor,
          'function',
          'interactive terminal provider must expose getTerminalDescriptor',
        );
        const descriptor = await options.provider.getTerminalDescriptor?.(options.taskId);
        if (descriptor === null || descriptor === undefined) {
          assert.ok(false, 'terminal descriptor should be present');
          return;
        }
        assertTerminalDescriptor(descriptor, assert);
      },
    });
  }

  if (capabilities.includes('command.exec')) {
    scenarios.push({
      name: 'command execution capability exposes a command descriptor',
      async run() {
        assert.equal(
          typeof options.provider.getCommandDescriptor,
          'function',
          'command executor provider must expose getCommandDescriptor',
        );
        const descriptor = await options.provider.getCommandDescriptor?.(options.taskId);
        if (descriptor === null || descriptor === undefined) {
          assert.ok(false, 'command descriptor should be present');
          return;
        }
        assertCommandDescriptor(descriptor, assert);
      },
    });
  }

  if (capabilities.includes('workspace.archive.transfer')) {
    scenarios.push({
      name: 'archive workspace capability exposes a workspace descriptor',
      async run() {
        assert.equal(
          typeof options.provider.getWorkspaceDescriptor,
          'function',
          'workspace transfer provider must expose getWorkspaceDescriptor',
        );
        const descriptor = await options.provider.getWorkspaceDescriptor?.(options.taskId);
        if (descriptor === null || descriptor === undefined) {
          assert.ok(false, 'workspace descriptor should be present');
          return;
        }
        assertWorkspaceDescriptor(descriptor, assert);
      },
    });
  }

  if (
    capabilities.includes('lifecycle.snapshot') ||
    capabilities.includes('lifecycle.sleep')
  ) {
    scenarios.push({
      name: 'provider retention features expose a retention policy',
      async run() {
        assert.equal(
          typeof options.provider.getRetentionPolicy,
          'function',
          'retention-capable provider must expose getRetentionPolicy',
        );
        const policy = await options.provider.getRetentionPolicy?.(options.taskId);
        assert.ok(policy !== null && policy !== undefined, 'retention policy should be present');
      },
    });
  }

  return scenarios;
}

export function assertSelectedSandboxRun(
  run: SelectedSandboxRun,
  expectedTaskId: string | undefined,
  assert: SandboxProviderConformanceAssert,
): void {
  if (expectedTaskId !== undefined) {
    assert.equal(run.taskId, expectedTaskId, 'selected run taskId must match');
  }
  assert.ok(typeof run.providerId === 'string' && run.providerId.length > 0, 'providerId is required');
  assert.ok(Array.isArray(run.capabilities), 'selected run capabilities must be an array');
  assertSandboxConnection(run.connection, expectedTaskId, assert);
}

export function assertTerminalDescriptor(
  descriptor: SandboxTerminalEndpointDescriptor,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(
    typeof descriptor.protocol === 'string' && descriptor.protocol.length > 0,
    'terminal protocol is required',
  );
  assert.ok(
    descriptor.url === undefined || typeof descriptor.url === 'string',
    'terminal url must be string when present',
  );
  assert.ok(
    descriptor.wsUrl === undefined || typeof descriptor.wsUrl === 'string',
    'terminal wsUrl must be string when present',
  );
}

export function assertCommandDescriptor(
  descriptor: SandboxCommandEndpointDescriptor,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(
    typeof descriptor.protocol === 'string' && descriptor.protocol.length > 0,
    'command protocol is required',
  );
  assert.ok(
    descriptor.baseUrl === undefined || typeof descriptor.baseUrl === 'string',
    'command baseUrl must be string when present',
  );
}

export function assertWorkspaceDescriptor(
  descriptor: SandboxWorkspaceDescriptor,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(
    typeof descriptor.mode === 'string' && descriptor.mode.length > 0,
    'workspace mode is required',
  );
  assert.ok(
    descriptor.path === undefined || typeof descriptor.path === 'string',
    'workspace path must be string when present',
  );
}
